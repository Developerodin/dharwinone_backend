import pick from '../../../src/utils/pick.js';

describe('pick', () => {
  test('should return an object with only the specified keys', () => {
    const object = { a: 1, b: 2, c: 3 };
    expect(pick(object, ['a', 'c'])).toEqual({ a: 1, c: 3 });
  });

  test('should ignore keys that do not exist on the object', () => {
    const object = { a: 1, b: 2 };
    expect(pick(object, ['a', 'c', 'd'])).toEqual({ a: 1 });
  });

  test('should return empty object when no keys are provided', () => {
    const object = { a: 1, b: 2 };
    expect(pick(object, [])).toEqual({});
  });

  test('should return empty object when no keys match', () => {
    const object = { a: 1, b: 2 };
    expect(pick(object, ['x', 'y'])).toEqual({});
  });

  test('should not pick inherited properties', () => {
    const object = Object.create({ inherited: true });
    object.own = 1;
    expect(pick(object, ['own', 'inherited'])).toEqual({ own: 1 });
  });

  test('should handle null/undefined object gracefully', () => {
    expect(pick(null, ['a'])).toEqual({});
    expect(pick(undefined, ['a'])).toEqual({});
  });
});
