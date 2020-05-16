/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as fs from 'graceful-fs';
import type {Config} from '@jest/types';

import {getStackTraceLines, getTopFrame} from 'jest-message-util';
import {
  addExtraLineBreaks,
  getSnapshotData,
  keyToTestName,
  removeExtraLineBreaks,
  removeLinesBeforeExternalMatcherTrap,
  saveSnapshotFile,
  serialize,
  testNameToKey,
} from './utils';
import {InlineSnapshot, saveInlineSnapshots} from './inline_snapshots';
import type {SnapshotData, SnapshotValue} from './types';

export type SnapshotStateOptions = {
  updateSnapshot: Config.SnapshotUpdateState;
  prettierPath: Config.Path;
  dontSerialize: boolean;
  expand?: boolean;
};

export type SnapshotMatchOptions = {
  testName: string;
  received: SnapshotValue;
  key?: string;
  serialized: boolean;
  inlineSnapshot?: string;
  isInline: boolean;
  error?: Error;
  hasInlineSnapshot: boolean;
};

type SnapshotReturnOptions = {
  actual: SnapshotValue;
  actualSerialized: string;
  count: number;
  expected: SnapshotValue;
  expectedSerialized: string;
  hasSnapshot: boolean;
  key: string;
  pass: boolean;
};

type SaveStatus = {
  deleted: boolean;
  saved: boolean;
};

export default class SnapshotState {
  private _counters: Map<string, number>;
  private _dirty: boolean;
  // @ts-ignore
  private _index: number;
  private _updateSnapshot: Config.SnapshotUpdateState;
  private _snapshotData: SnapshotData;
  private _initialData: SnapshotData;
  private _snapshotPath: Config.Path;
  private _inlineSnapshots: Array<InlineSnapshot>;
  private _uncheckedKeys: Set<string>;
  private _prettierPath: Config.Path;

  added: number;
  expand: boolean;
  matched: number;
  unmatched: number;
  updated: number;

  constructor(snapshotPath: Config.Path, options: SnapshotStateOptions) {
    this._snapshotPath = snapshotPath;
    const {data, dirty} = getSnapshotData(
      this._snapshotPath,
      options.updateSnapshot,
    );
    this._initialData = data;
    this._snapshotData = data;
    this._dirty = dirty;
    this._prettierPath = options.prettierPath;
    this._inlineSnapshots = [];
    this._uncheckedKeys = new Set(Object.keys(this._snapshotData));
    this._counters = new Map();
    this._index = 0;
    this.expand = options.expand || false;
    this.added = 0;
    this.matched = 0;
    this.unmatched = 0;
    this._updateSnapshot = options.updateSnapshot;
    this.updated = 0;
  }

  markSnapshotsAsCheckedForTest(testName: string): void {
    this._uncheckedKeys.forEach(uncheckedKey => {
      if (keyToTestName(uncheckedKey) === testName) {
        this._uncheckedKeys.delete(uncheckedKey);
      }
    });
  }

  private _addSnapshot(
    key: string,
    received: SnapshotValue,
    options: {serialized: boolean; isInline: boolean; error?: Error},
  ): void {
    this._dirty = true;
    if (options.isInline) {
      const error = options.error || new Error();
      const lines = getStackTraceLines(
        removeLinesBeforeExternalMatcherTrap(error.stack || ''),
      );
      const frame = getTopFrame(lines);
      if (!frame) {
        throw new Error(
          "Jest: Couldn't infer stack frame for inline snapshot.",
        );
      }
      this._inlineSnapshots.push({
        frame,
        serialized: options.serialized,
        snapshot: received,
      });
    } else {
      this._snapshotData[key] = received;
    }
  }

  clear(): void {
    this._snapshotData = this._initialData;
    this._inlineSnapshots = [];
    this._counters = new Map();
    this._index = 0;
    this.added = 0;
    this.matched = 0;
    this.unmatched = 0;
    this.updated = 0;
  }

  save(): SaveStatus {
    const hasExternalSnapshots = Object.keys(this._snapshotData).length;
    const hasInlineSnapshots = this._inlineSnapshots.length;
    const isEmpty = !hasExternalSnapshots && !hasInlineSnapshots;

    const status: SaveStatus = {
      deleted: false,
      saved: false,
    };

    if ((this._dirty || this._uncheckedKeys.size) && !isEmpty) {
      if (hasExternalSnapshots) {
        saveSnapshotFile(this._snapshotData, this._snapshotPath);
      }
      if (hasInlineSnapshots) {
        saveInlineSnapshots(this._inlineSnapshots, this._prettierPath);
      }
      status.saved = true;
    } else if (!hasExternalSnapshots && fs.existsSync(this._snapshotPath)) {
      if (this._updateSnapshot === 'all') {
        fs.unlinkSync(this._snapshotPath);
      }
      status.deleted = true;
    }

    return status;
  }

  getUncheckedCount(): number {
    return this._uncheckedKeys.size || 0;
  }

  getUncheckedKeys(): Array<string> {
    return Array.from(this._uncheckedKeys);
  }

  removeUncheckedKeys(): void {
    if (this._updateSnapshot === 'all' && this._uncheckedKeys.size) {
      this._dirty = true;
      this._uncheckedKeys.forEach(key => delete this._snapshotData[key]);
      this._uncheckedKeys.clear();
    }
  }

  compare(received: SnapshotValue, expected: SnapshotValue): boolean {
    if (typeof received !== typeof expected) {
      return false;
    }

    // Functions cannot be serialized and comparison by reference in a snapshot would
    // require extremly complex and expensive AST traversal
    // and would also be not feasible to implement with regular non-inline snapshots.
    // The only viable check to do is to expect any function
    if (typeof received === 'function') {
      return true;
    }

    // NaN
    if (
      typeof received === 'number' &&
      Number.isNaN(received) &&
      Number.isNaN(expected)
    ) {
      return true;
    }

    // Symbols are checked by key checking by reference is not feasible
    if (typeof received === 'symbol') {
      return received.toString() === (expected as symbol).toString();
    }

    // Object or array deep
    // Might need a circular reference check here, or a Maximum call stack error would be thrown
    // Circular references should probably be represented in the snpashot using a special value
    // window.window could be snapshoted as "Circular reference to received on received['window']"
    if (received && typeof received === 'object') {
      if (!expected) {
        return false;
      }

      let receivedKeyCount = 0;

      // for .. in interates over all enumerable property keys, including inherited ones
      for (const key in received) {
        receivedKeyCount++;
        if (
          !this.compare(
            (received as {[key: string]: SnapshotValue})?.[key as string],
            (expected as {[key: string]: SnapshotValue})?.[key as string],
          )
        ) {
          return false;
        }
      }

      let expectedKeyCount = 0;

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for (const _ in expected as object) {
        expectedKeyCount++;
      }

      if (receivedKeyCount !== expectedKeyCount) {
        return false;
      }
    }

    // Default to strict equality comparison
    return received === expected;
  }

  match({
    testName,
    received,
    key,
    serialized,
    inlineSnapshot,
    hasInlineSnapshot: hasExpected,
    isInline,
    error,
  }: SnapshotMatchOptions): SnapshotReturnOptions {
    this._counters.set(testName, (this._counters.get(testName) || 0) + 1);
    const count = Number(this._counters.get(testName));

    if (!key) {
      key = testNameToKey(testName, count);
    }

    // Do not mark the snapshot as "checked" if the snapshot is inline and
    // there's an external snapshot. This way the external snapshot can be
    // removed with `--updateSnapshot`.
    if (!(isInline && this._snapshotData[key] !== undefined)) {
      this._uncheckedKeys.delete(key);
    }

    const value = serialized
      ? addExtraLineBreaks(serialize(received))
      : received;
    const valueSerialized = serialized
      ? (value as string)
      : addExtraLineBreaks(serialize(received));
    const expected = isInline ? inlineSnapshot : this._snapshotData[key];
    const expectedSerialized = addExtraLineBreaks(serialize(expected));
    const pass = serialized
      ? expected === value
      : this.compare(received, expected);
    const hasSnapshot = isInline
      ? hasExpected
      : Object.keys(this._snapshotData).includes(key);
    const snapshotIsPersisted = isInline || fs.existsSync(this._snapshotPath);
    const defaultExpected = serialized
      ? ''
      : hasSnapshot
      ? expected
      : undefined;
    const defaultActual = serialized ? '' : hasSnapshot ? received : undefined;

    if (pass && !isInline) {
      // Executing a snapshot file as JavaScript and writing the strings back
      // when other snapshots have changed loses the proper escaping for some
      // characters. Since we check every snapshot in every test, use the newly
      // generated formatted string.
      // Note that this is only relevant when a snapshot is added and the dirty
      // flag is set.
      this._snapshotData[key] = value;
    }

    // These are the conditions on when to write snapshots:
    //  * There's no snapshot file in a non-CI environment.
    //  * There is a snapshot file and we decided to update the snapshot.
    //  * There is a snapshot file, but it doesn't have this snaphsot.
    // These are the conditions on when not to write snapshots:
    //  * The update flag is set to 'none'.
    //  * There's no snapshot file or a file without this snapshot on a CI environment.
    if (
      (hasSnapshot && this._updateSnapshot === 'all') ||
      ((!hasSnapshot || !snapshotIsPersisted) &&
        (this._updateSnapshot === 'new' || this._updateSnapshot === 'all'))
    ) {
      if (this._updateSnapshot === 'all') {
        if (!pass) {
          if (hasSnapshot) {
            this.updated++;
          } else {
            this.added++;
          }
          this._addSnapshot(key, value, {
            error,
            isInline,
            serialized,
          });
        } else {
          this.matched++;
        }
      } else {
        this._addSnapshot(key, value, {
          error,
          isInline,
          serialized,
        });
        this.added++;
      }

      return {
        actual: defaultActual,
        actualSerialized: '',
        count,
        expected: defaultExpected,
        expectedSerialized: '',
        hasSnapshot,
        key,
        pass: true,
      };
    } else {
      if (!pass) {
        this.unmatched++;
        return {
          actual: serialized
            ? removeExtraLineBreaks(value as string)
            : received,
          actualSerialized: removeExtraLineBreaks(valueSerialized),
          count,
          expected: hasSnapshot
            ? serialized
              ? removeExtraLineBreaks(expected as string)
              : expected
            : undefined,
          expectedSerialized,
          hasSnapshot,
          key,
          pass: false,
        };
      } else {
        this.matched++;
        return {
          actual: defaultActual,
          actualSerialized: '',
          count,
          expected: defaultExpected,
          expectedSerialized: '',
          hasSnapshot,
          key,
          pass: true,
        };
      }
    }
  }

  fail(testName: string, _received: unknown, key?: string): string {
    this._counters.set(testName, (this._counters.get(testName) || 0) + 1);
    const count = Number(this._counters.get(testName));

    if (!key) {
      key = testNameToKey(testName, count);
    }

    this._uncheckedKeys.delete(key);
    this.unmatched++;
    return key;
  }
}
