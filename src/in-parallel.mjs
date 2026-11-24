// Runs a task for each item with at most `limit` running at once and returns the results in the items' order.
// The first failure is rethrown after the tasks already started have settled, and no further task starts.
export async function inParallel(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  let failure;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length && !failure) {
      const index = next++;
      try {
        results[index] = await task(items[index], index);
      } catch (error) {
        failure ??= { error };
      }
    }
  });
  await Promise.all(lanes);
  if (failure) throw failure.error;
  return results;
}
