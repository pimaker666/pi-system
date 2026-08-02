'use client'

import { useState, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'

interface UseImageUploadOptions {
  bucket: string
  folder?: string
}

interface UseImageUploadResult {
  upload: (file: File) => Promise<string>
  uploading: boolean
  error: string | null
}

/**
 * Client-side direct upload to a public Supabase Storage bucket.
 * Bypasses Server Action body-size limits for images/logos and returns a
 * public URL that can be stored directly on the record.
 */
export function useImageUpload({
  bucket,
  folder = '',
}: UseImageUploadOptions): UseImageUploadResult {
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const upload = useCallback(
    async (file: File): Promise<string> => {
      setUploading(true)
      setError(null)
      try {
        const supabase = createClient()
        const ext = file.name.split('.').pop() ?? 'bin'
        const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
        const path = folder ? `${folder}/${name}` : name

        const { error: uploadError } = await supabase.storage
          .from(bucket)
          .upload(path, file, { cacheControl: '3600', upsert: false })
        if (uploadError) throw uploadError

        const {
          data: { publicUrl },
        } = supabase.storage.from(bucket).getPublicUrl(path)
        return publicUrl
      } catch (e) {
        const msg = e instanceof Error ? e.message : '上传失败'
        setError(msg)
        throw e
      } finally {
        setUploading(false)
      }
    },
    [bucket, folder],
  )

  return { upload, uploading, error }
}
