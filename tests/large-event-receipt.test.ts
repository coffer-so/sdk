import { decodeContractEvent } from '../src';
import fixture from './fixtures/large-pool-initialized-v2.json';

test('actual1135-byte N10 PoolInitializedV2 retains every original field', () => {
  const raw = Buffer.from(fixture.sample.base64, 'base64');
  expect(raw.length).toBe(1135);
  const decoded = decodeContractEvent(raw.toString('base64'), 'cofferPool');
  expect(decoded?.kind).toBe('PoolInitializedV2');
  if (!decoded || decoded.kind !== 'PoolInitializedV2') throw Error('Missing original financial event');
  expect(decoded.data.mints).toHaveLength(10);
  expect(decoded.data.token_programs).toHaveLength(10);
  expect(decoded.data.normalized_weights).toHaveLength(10);
  expect(decoded.data.lp_uri).toBe('https://example.invalid/n10');
  for (let removed = 1; removed <= 32; removed++) expect(decodeContractEvent(raw.subarray(0, -removed).toString('base64'), 'cofferPool')).toBeNull();
  // Preserve the established decoder's documented trailing-byte tolerance.
  expect(decodeContractEvent(Buffer.concat([raw, Buffer.from([1, 2, 3])]).toString('base64'), 'cofferPool')?.kind).toBe('PoolInitializedV2');
});
