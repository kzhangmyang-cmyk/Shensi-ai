import { createHash } from 'node:crypto';
import { reviewedVendorPathExamples } from './reviewed-vendor-path-examples.mjs';

const concreteHomePath = /(?:\/Users|\/home)\/(?![$%{*?])[\p{L}\p{N}._-]+(?:\/|$)/u;

export function findDeveloperAbsolutePath(value) {
  return concreteHomePath.exec(value)?.[0] ?? null;
}

export function isReviewedVendorPathExample(relativePath, bytes) {
  return Object.hasOwn(reviewedVendorPathExamples, relativePath)
    && createHash('sha256').update(bytes).digest('hex') === reviewedVendorPathExamples[relativePath];
}
