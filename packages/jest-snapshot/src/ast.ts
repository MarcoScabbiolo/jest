import type * as tTypes from '@babel/types';

import type {SnapshotValue} from './types';
import {escapeBacktickString} from './utils';

const t: typeof import('@babel/types') = require(require.resolve(
  '@babel/types',
  {
    [Symbol.for('OUTSIDE_JEST_VM_RESOLVE_OPTION')]: true,
  } as any,
));

export interface GenerateSnapshotOptions {
  serialized: boolean;
}

export type GeneratedAst =
  | tTypes.StringLiteral
  | tTypes.NumberLiteral
  | tTypes.BigIntLiteral
  | tTypes.BooleanLiteral
  | tTypes.CallExpression
  | tTypes.Identifier
  | tTypes.NullLiteral
  | tTypes.ArrayExpression
  | tTypes.MemberExpression
  | tTypes.ObjectExpression;

const getSymbolAstFromStandardSymbol = (
  symbol: symbol,
): tTypes.MemberExpression | void => {
  const name = /Symbol\(Symbol\.(.+)\)/.exec(symbol.toString());

  if (!name) {
    return undefined;
  }

  return t.memberExpression(t.identifier('Symbol'), t.identifier(name));
};

const generateAstFromValue = (value: SnapshotValue): GeneratedAst => {
  if (value === undefined) {
    return t.identifier('undefined');
  } else if (value === null) {
    return t.nullLiteral();
  } else if (typeof value === 'string') {
    return t.stringLiteral(value);
  } else if (typeof value === 'number') {
    return t.numericLiteral(value);
  } else if (typeof value === 'bigint') {
    return t.bigIntLiteral(value.toString());
  } else if (typeof value === 'boolean') {
    return t.booleanLiteral(value);
  } else if (typeof value === 'function') {
    return t.callExpression(
      t.memberExpression(t.identifier('expect'), t.identifier('any')),
      [t.identifier('Function')],
    );
  } else if (Array.isArray(value)) {
    return t.arrayExpression(value.map(generateAstFromValue));
  } else if (typeof value?.[Symbol.iterator] === 'function') {
    return t.arrayExpression(
      Array.from(value as Iterable<SnapshotValue>).map(generateAstFromValue),
    );
  } else if (typeof value === 'symbol') {
    const referencedSymbol = getSymbolAstFromStandardSymbol(value);
    if (referencedSymbol) {
      return referencedSymbol;
    } else {
      return t.stringLiteral(value.toString());
    }
  } else {
    const obj = value as object;
    const properties: Array<tTypes.ObjectProperty> = [];

    for (const key in obj) {
      properties.push(
        t.objectProperty(
          t.identifier(key.toString()),
          generateAstFromValue((obj as {[key: string]: SnapshotValue})[key]),
        ),
      );
    }

    return t.objectExpression(properties);
  }
};

export const generateSnapshot = (
  value: SnapshotValue,
  options: GenerateSnapshotOptions,
): any => {
  if (options.serialized) {
    return t.templateLiteral(
      [t.templateElement({raw: escapeBacktickString(value as string)})],
      [],
    );
  }

  return generateAstFromValue(value);
};
