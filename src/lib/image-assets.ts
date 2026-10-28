/** 允许登记展示元数据的图片桶。常量不能放在 "use server" 文件里（运行时导出会触发 Next 校验崩溃）。 */
export const IMAGE_ASSET_BUCKETS = [
  'business-payment-proofs',
  'business-shipment-screenshots',
  'customer-assets',
] as const

export type ImageAssetBucket = (typeof IMAGE_ASSET_BUCKETS)[number]

export interface ImageAssetMetaEntry {
  displayName: string | null
  uploadedAt: string | null
}

export type ImageAssetMetaMap = Record<string, ImageAssetMetaEntry>
