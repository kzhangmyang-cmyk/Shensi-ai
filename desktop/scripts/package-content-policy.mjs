const concreteHomePath = /(?:\/Users|\/home)\/(?![$%{*?])[\p{L}\p{N}._-]+(?:\/|$)/u;

export function findDeveloperAbsolutePath(value) {
  return concreteHomePath.exec(value)?.[0] ?? null;
}
