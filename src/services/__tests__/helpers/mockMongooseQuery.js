/**
 * Mimics Mongoose Query: await findOne(), .sort(), and .session() in any order.
 * `onSession(session)` (optional) is invoked with whatever session is passed to
 * `.session(...)`, so tests can assert the transaction session is threaded through.
 */
export function mockFindOne({ direct = null, onSort = null, onSession = null } = {}) {
  return (filter) => {
    const resolvedDirect = typeof direct === 'function' ? direct(filter) : direct;
    const resolvedSort =
      onSort != null
        ? typeof onSort === 'function'
          ? onSort(filter)
          : onSort
        : resolvedDirect;
    const makeChain = (value) => {
      const q = {
        sort: () => makeChain(resolvedSort),
        session: (s) => {
          if (typeof onSession === 'function') onSession(s);
          return makeChain(value);
        },
        then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
      };
      return q;
    };
    return makeChain(resolvedDirect);
  };
}
