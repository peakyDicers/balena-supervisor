import * as t from 'io-ts';
import * as _ from 'lodash';

import { InternalInconsistencyError } from '../lib/errors';
import { checkTruthy } from '../lib/validation';

const permissiveValue = t.union([
	t.boolean,
	t.string,
	t.number,
	t.null,
	t.undefined,
]);
type PermissiveType = typeof permissiveValue;

export const PermissiveBoolean = new t.Type<boolean, t.TypeOf<PermissiveType>>(
	'PermissiveBoolean',
	_.isBoolean,
	(m, c) =>
		permissiveValue.validate(m, c).chain(v => {
			switch (typeof v) {
				case 'string':
				case 'boolean':
				case 'number':
					const val = checkTruthy(v);
					if (val == null) {
						return t.failure(v, c);
					}
					return t.success(val);
				case 'undefined':
					return t.success(false);
				case 'object':
					if (_.isNull(v)) {
						return t.success(false);
					} else {
						return t.failure(v, c);
					}
				default:
					return t.failure(v, c);
			}
		}),
	() => {
		throw new InternalInconsistencyError(
			'Encode not defined for PermissiveBoolean',
		);
	},
);

export const PermissiveNumber = new t.Type<number, string | number>(
	'PermissiveNumber',
	_.isNumber,
	(m, c) =>
		t
			.union([t.string, t.number])
			.validate(m, c)
			.chain(v => {
				switch (typeof v) {
					case 'number':
						return t.success(v);
					case 'string':
						const i = parseInt(v, 10);
						if (_.isNaN(i)) {
							return t.failure(v, c);
						}
						return t.success(i);
					default:
						return t.failure(v, c);
				}
			}),
	() => {
		throw new InternalInconsistencyError(
			'Encode not defined for PermissiveNumber',
		);
	},
);

// Define this differently, so that we can add a generic to it
export class StringJSON<T> extends t.Type<T, string> {
	public readonly _tag: 'StringJSON' = 'StringJSON';
	constructor(type: t.InterfaceType<any>) {
		super(
			'StringJSON',
			(m): m is T => type.decode(m).isRight(),
			(m, c) =>
				// Accept either an object, or a string which represents the
				// object
				t
					.union([t.string, type])
					.validate(m, c)
					.chain(v => {
						let obj: T;
						if (typeof v === 'string') {
							obj = JSON.parse(v);
						} else {
							obj = v;
						}
						return type.decode(obj);
					}),
			() => {
				throw new InternalInconsistencyError(
					'Encode not defined for StringJSON',
				);
			},
		);
	}
}

export const NullOrUndefined = t.union([t.undefined, t.null]);
