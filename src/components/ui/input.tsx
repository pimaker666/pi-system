import * as React from 'react'
import { cn } from '@/lib/utils'

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, onWheel, ...props }, ref) => (
    <input
      type={type}
      className={cn(
        'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      ref={ref}
      // 数字输入框禁用鼠标滚轮改值：滚轮时让输入框失焦，
      // 数值不会被滚动改变，页面仍可正常滚动。
      onWheel={
        type === 'number'
          ? (e) => {
              e.currentTarget.blur()
              onWheel?.(e)
            }
          : onWheel
      }
      {...props}
    />
  ),
)
Input.displayName = 'Input'

export { Input }
