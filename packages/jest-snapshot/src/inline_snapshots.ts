/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import fs from 'fs';
// import path from 'path';
import semver from 'semver';
import {loadPartialConfig} from '@babel/core';
import generate from '@babel/generator';
import {parse, ParserOptions} from '@babel/parser';
import traverse from '@babel/traverse';
import {templateElement, templateLiteral, file, Expression, CallExpression} from '@babel/types';
import {Frame} from 'jest-message-util';

import {Config} from '@jest/types';
import {escapeBacktickString} from './utils';

export type InlineSnapshot = {
  snapshot: string;
  frame: Frame;
  node?: Expression;
};
type BabelTraverse = typeof traverse;

export const saveInlineSnapshots = (
  snapshots: Array<InlineSnapshot>,
  prettier: any,
  babelTraverse: Function,
) => {
  const snapshotsByFile = groupSnapshotsByFile(snapshots);

  for (const sourceFilePath of Object.keys(snapshotsByFile)) {
    saveSnapshotsForFile(
      snapshotsByFile[sourceFilePath],
      sourceFilePath,
      prettier && semver.gte(prettier.version, '1.5.0') ? prettier : null,
      babelTraverse as BabelTraverse,
    );
  }
};

const saveSnapshotsForFile = (
  snapshots: Array<InlineSnapshot>,
  sourceFilePath: Config.Path,
  prettier: any,
  babelTraverse: BabelTraverse,
) => {
  const sourceFile = fs.readFileSync(sourceFilePath, 'utf8');

  let newSourceFile: string;
  {
    const {options} = loadPartialConfig({filename: sourceFilePath})!;
    if (!options.plugins) {
      options.plugins = [];
    }

    // TypeScript projects may not have a babel config; make sure they can be parsed anyway.
    if (/\.tsx?$/.test(sourceFilePath)) {
      options.plugins.push('typescript');
    }
    if (/\.tsx/.test(sourceFilePath)) {
      options.plugins.push('jsx');
    }

    const ast = parse(sourceFile, options as ParserOptions);
    traverseAst(snapshots, ast, babelTraverse);

    // substitute in the snapshots in reverse order, so slice calculations aren't thrown off.
    newSourceFile = snapshots.reduceRight((sourceSoFar, nextSnapshot) => {
      if (
        !nextSnapshot.node ||
        typeof nextSnapshot.node.start !== 'number' ||
        typeof nextSnapshot.node.end !== 'number'
      ) {
        throw new Error('Jest: no snapshot insert location found');
      }
      return (
        sourceSoFar.slice(0, nextSnapshot.node.start) +
        generate(nextSnapshot.node).code +
        sourceSoFar.slice(nextSnapshot.node.end)
      );
    }, sourceFile);
  }

  if (prettier) {
    // todo: put formatting back in
  }

  if (newSourceFile !== sourceFile) {
    fs.writeFileSync(sourceFilePath, newSourceFile);
  }
};

const groupSnapshotsBy = (
  createKey: (inlineSnapshot: InlineSnapshot) => string,
) => (snapshots: Array<InlineSnapshot>) =>
    snapshots.reduce<{[key: string]: Array<InlineSnapshot>}>(
      (object, inlineSnapshot) => {
        const key = createKey(inlineSnapshot);
        return {...object, [key]: (object[key] || []).concat(inlineSnapshot)};
      },
      {},
    );

const groupSnapshotsByFrame = groupSnapshotsBy(({frame: {line, column}}) =>
  typeof line === 'number' && typeof column === 'number'
    ? `${line}:${column - 1}`
    : '',
);
const groupSnapshotsByFile = groupSnapshotsBy(({frame: {file}}) => file);

const indent = (snapshot: string, numIndents: number, indentation: string) => {
  const lines = snapshot.split('\n');
  return lines
    .map((line, index) => {
      if (index === 0) {
        // First line is either a 1-line snapshot or a blank line.
        return line;
      } else if (index !== lines.length - 1) {
        // Do not indent empty lines.
        if (line === '') {
          return line;
        }

        // Not last line, indent one level deeper than expect call.
        return indentation.repeat(numIndents + 1) + line;
      } else {
        // The last line should be placed on the same level as the expect call.
        return indentation.repeat(numIndents) + line;
      }
    })
    .join('\n');
};

const getAst = (
  parsers: {[key: string]: (text: string) => any},
  inferredParser: string,
  text: string,
) => {
  // Flow uses a 'Program' parent node, babel expects a 'File'.
  let ast = parsers[inferredParser](text);
  if (ast.type !== 'File') {
    ast = file(ast, ast.comments, ast.tokens);
    delete ast.program.comments;
  }
  return ast;
};

// This parser inserts snapshots into the AST.
export const createInsertionParser = (
  snapshots: Array<InlineSnapshot>,
  inferredParser: string,
  babelTraverse: BabelTraverse,
) => (
  text: string,
  parsers: {[key: string]: (text: string) => any},
  options: any,
  ) => {
    // Workaround for https://github.com/prettier/prettier/issues/3150
    options.parser = inferredParser;
    const ast = parsers[inferredParser](text);

    traverseAst(snapshots, ast, babelTraverse);

    return ast;
  };

const traverseAst = (
  snapshots: Array<InlineSnapshot>,
  ast: any,
  babelTraverse: BabelTraverse,
) => {
  // Flow uses a 'Program' parent node, babel expects a 'File'.
  if (ast.type !== 'File') {
    ast = file(ast, ast.comments, ast.tokens);
    delete ast.program.comments;
  }

  const groupedSnapshots = groupSnapshotsByFrame(snapshots);
  const remainingSnapshots = new Set(snapshots.map(({snapshot}) => snapshot));

  babelTraverse(ast, {
    CallExpression({node}) {
      const {arguments: args, callee} = node;
      if (
        callee.type !== 'MemberExpression' ||
        callee.property.type !== 'Identifier'
      ) {
        return;
      }
      const {line, column} = callee.property.loc.start;
      const snapshotsForFrame = groupedSnapshots[`${line}:${column}`];
      if (!snapshotsForFrame) {
        return;
      }
      if (snapshotsForFrame.length > 1) {
        throw new Error(
          'Jest: Multiple inline snapshots for the same call are not supported.',
        );
      }
      const snapshotIndex = args.findIndex(
        ({type}) => type === 'TemplateLiteral',
      );
      const values = snapshotsForFrame.map(inlineSnapshot => {
        inlineSnapshot.node = node;
        const {snapshot} = inlineSnapshot;
        remainingSnapshots.delete(snapshot);

        return templateLiteral(
          [templateElement({raw: escapeBacktickString(snapshot)})],
          [],
        );
      });
      const replacementNode = values[0];

      if (snapshotIndex > -1) {
        args[snapshotIndex] = replacementNode;
      } else {
        args.push(replacementNode);
      }
    },
  });

  if (remainingSnapshots.size) {
    throw new Error(`Jest: Couldn't locate all inline snapshots.`);
  }
};

// This parser formats snapshots to the correct indentation.
const createFormattingParser = (
  inferredParser: string,
  babelTraverse: Function,
) => (
  text: string,
  parsers: {[key: string]: (text: string) => any},
  options: any,
  ) => {
    // Workaround for https://github.com/prettier/prettier/issues/3150
    options.parser = inferredParser;

    const ast = getAst(parsers, inferredParser, text);
    babelTraverse(ast, {
      CallExpression({node: {arguments: args, callee}}: {node: CallExpression}) {
        if (
          callee.type !== 'MemberExpression' ||
          callee.property.type !== 'Identifier' ||
          callee.property.name !== 'toMatchInlineSnapshot' ||
          !callee.loc ||
          callee.computed
        ) {
          return;
        }

        let snapshotIndex: number | undefined;
        let snapshot: string | undefined;
        for (let i = 0; i < args.length; i++) {
          const node = args[i];
          if (node.type === 'TemplateLiteral') {
            snapshotIndex = i;
            snapshot = node.quasis[0].value.raw;
          }
        }
        if (snapshot === undefined || snapshotIndex === undefined) {
          return;
        }

        const useSpaces = !options.useTabs;
        snapshot = indent(
          snapshot,
          Math.ceil(
            useSpaces
              ? callee.loc.start.column / options.tabWidth
              : callee.loc.start.column / 2, // Each tab is 2 characters.
          ),
          useSpaces ? ' '.repeat(options.tabWidth) : '\t',
        );

        const replacementNode = templateLiteral(
          [
            templateElement({
              raw: snapshot,
            }),
          ],
          [],
        );
        args[snapshotIndex] = replacementNode;
      },
    });

    return ast;
  };

// const simpleDetectParser = (filePath: Config.Path) => {
//   const extname = path.extname(filePath);
//   if (/tsx?$/.test(extname)) {
//     return 'typescript';
//   }
//   return 'babylon';
// };
