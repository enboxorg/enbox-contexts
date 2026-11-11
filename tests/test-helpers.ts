import type { RecordCodec } from '../src/index.js';

export function jsonCodec<T>(): RecordCodec<T> {
  return {
    encode: value => ({
      data: new Blob([JSON.stringify(value)], { type: 'application/json' }),
      dataFormat: 'application/json',
    }),
    decode: async data => (await data.json()) as T,
  };
}
