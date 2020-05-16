/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {MatcherState} from 'expect';
import type SnapshotState from './State';

export type Context = MatcherState & {
  snapshotState: SnapshotState;
};

export type MatchSnapshotConfig = {
  context: Context;
  hint?: string;
  inlineSnapshot?: string;
  hasInlineSnapshot: boolean;
  isInline: boolean;
  matcherName: string;
  properties?: object;
  received: SnapshotValue;
  receivedAnything: boolean;
};

export type SnapshotValue =
  | string
  | symbol
  | {[key: string]: SnapshotValue}
  | Array<SnapshotValue>
  | Function
  | number
  | boolean
  | null
  | undefined;

export type SnapshotData = Record<string, SnapshotValue>;
