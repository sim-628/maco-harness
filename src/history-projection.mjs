// Historical evidence has a revocable reference epoch. Keep the original log
// and balanced tool exchanges intact while withholding stale recalled prose.
// Executed mail-operation receipts are independent facts and are never erased.
export function projectHistoryMessage(message, settings) {
  if (message.historyEpoch === undefined || (settings.enabled && message.historyEpoch === settings.epoch)) return message
  const {providerState, ...visible} = message
  return {...visible, content:'[Maco: previously recalled history is unavailable after a memory change. Search again if history is enabled; do not infer its contents.]'}
}
