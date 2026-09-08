import { promisify } from 'node:util'
import { inflate } from 'node:zlib'

/**
 * 导出用图片可渲染性校验（仅服务端使用）。
 *
 * 背景：@react-pdf/renderer 在解码损坏的 PNG 时会在流内部抛出 zlib
 * Z_DATA_ERROR（incorrect data check），该错误逃逸成 uncaughtException，
 * 导致导出请求永久挂起、客户端拿不到任何响应。因此在嵌入前先做一次
 * 结构性校验，坏图直接跳过并在导出结果中标注“不可用”。
 */

const inflateAsync = promisify(inflate)

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff])
const JPEG_EOI = Buffer.from([0xff, 0xd9])

function isRenderableJpeg(buffer: Buffer): boolean {
  // 至少要有 SOI(FFD8FF) 与 EOI(FFD9)，否则视为被截断的图片。
  return buffer.length > 4 && buffer.indexOf(JPEG_EOI, 3) > 0
}

async function isRenderablePng(buffer: Buffer): Promise<boolean> {
  const idatParts: Buffer[] = []
  let offset = 8
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    const dataEnd = offset + 8 + length
    // 每个 chunk 尾部还有 4 字节 CRC，越界即视为损坏。
    if (dataEnd + 4 > buffer.length) return false
    if (type === 'IDAT') idatParts.push(buffer.subarray(offset + 8, dataEnd))
    if (type === 'IEND') break
    offset = dataEnd + 4
  }
  if (idatParts.length === 0) return false
  try {
    await inflateAsync(Buffer.concat(idatParts))
    return true
  } catch {
    return false
  }
}

/** 判断截图字节是否可安全嵌入 PDF/XLSX；只接受结构完整的 PNG 与 JPEG。 */
export async function isRenderableExportImage(buffer: Buffer): Promise<boolean> {
  if (buffer.length < 12) return false
  if (buffer.subarray(0, 3).equals(JPEG_SIGNATURE)) return isRenderableJpeg(buffer)
  if (buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return isRenderablePng(buffer)
  return false
}
