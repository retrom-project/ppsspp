export const contentAbi = 'content-io-v1';
export const contractSha256 = '9601f63ba9d1bad095b42b32a3d6167166535be246a87f0efac7c5b125ed27bf';
export function validateContent(source, content) {
  if (!source || Object.keys(source).sort().join(',') !== 'sha256,sizeBytes' || !/^[a-f0-9]{64}$/.test(source.sha256) ||
      !Number.isSafeInteger(source.sizeBytes) || source.sizeBytes < 1 || source.sizeBytes > 2147483647 ||
      content?.abi !== contentAbi || content.contractSha256 !== contractSha256 || content.sizeBytes !== source.sizeBytes ||
      typeof content.syncClientUrl !== 'string' || !content.syncClientUrl.startsWith('blob:') ||
      !/^[a-f0-9]{64}$/.test(content.objectKey) || typeof content.port?.postMessage !== 'function' ||
      Object.prototype.toString.call(content.buffer) !== '[object SharedArrayBuffer]' || content.buffer.byteLength !== 262208) {
    throw Error('CONTENT_IO_ABI_MISMATCH');
  }
}
export async function loadContentReader(source, content, load = url => import(url)) {
  validateContent(source, content);
  const module = await load(content.syncClientUrl);
  if (module.abi !== contentAbi || module.contractSha256 !== contractSha256 || typeof module.createSyncContentReader !== 'function') {
    throw Error('CONTENT_IO_ABI_MISMATCH');
  }
  const {fileId, objectKey, sizeBytes, port, buffer, sessionId, channelId, epoch, l1BudgetBytes} = content;
  return module.createSyncContentReader({fileId, objectKey, sizeBytes, port, buffer, sessionId, channelId, epoch, l1BudgetBytes});
}
