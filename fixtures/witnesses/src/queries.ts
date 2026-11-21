export const isCurrent = (createdAt: number, updatedAt: number, expiresAt: number) => createdAt < expiresAt;

export const isEntryCurrent = (entry: { createdAt: number; updatedAt: number; expiresAt: number }) => entry.createdAt < entry.expiresAt;

export const positionOf = (items: number[], target: number) => items.indexOf(target);

export const hasFlag = (flags: number, mask: number) => (flags & mask) !== 0;

export const sumFirst = (items: number[], count: number) => items.slice(0, count).reduce((sum, value) => sum + value, 0);
