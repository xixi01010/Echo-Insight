let clientCacheEpoch = 0;

export function readClientCacheEpoch(): number {
  return clientCacheEpoch;
}

export function advanceClientCacheEpoch(): number {
  clientCacheEpoch += 1;
  return clientCacheEpoch;
}

export function isClientCacheEpochCurrent(epoch: number): boolean {
  return epoch === clientCacheEpoch;
}
