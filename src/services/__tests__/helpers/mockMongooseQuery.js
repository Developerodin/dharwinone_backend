/** Mimics Mongoose Query: await findOne() and await findOne().sort(). */
export function mockFindOne({ direct = null, onSort = null } = {}) {
  return (filter) => {
    const resolvedDirect = typeof direct === 'function' ? direct(filter) : direct;
    const resolvedSort =
      onSort != null
        ? typeof onSort === 'function'
          ? onSort(filter)
          : onSort
        : resolvedDirect;
    const q = {
      sort: () => Promise.resolve(resolvedSort),
    };
    q.then = (resolve, reject) => Promise.resolve(resolvedDirect).then(resolve, reject);
    return q;
  };
}
