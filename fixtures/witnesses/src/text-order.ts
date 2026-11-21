export const scalarCount = (text: string) => Array.from(text).length;

export const codeUnits = (text: string) => text.length;

export const byCreated = (rows: { id: string; createdAt: number; updatedAt: number }[]) =>
  rows.toSorted((a, b) => a.createdAt - b.createdAt);
