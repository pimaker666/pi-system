# 字体文件

PDF（形式发票）渲染依赖两套字体：**Noto Sans SC**（中文正文 / 客户与产品名）和 **Inter**（英文标题、表头、标签、金额）。请将以下四个 `.ttf` 文件放到本目录：

```
public/fonts/
├── NotoSansSC-Regular.ttf   # 中文正文
├── NotoSansSC-Bold.ttf      # 中文加粗
├── Inter-Regular.ttf        # 英文正文/数字
└── Inter-Bold.ttf           # 英文标题/表头
```

> 缺少任意一个文件，构建时 `registerPdfFonts()` 会因 `ENOENT` 报错，或对应文字渲染为空白。

## 为什么必须是 .ttf

`@react-pdf/renderer` 对 OTF/CFF 字体支持不稳定，经常渲染出空白或方框。务必使用 **TrueType（.ttf）** 格式，否则中文会乱码。

## 获取字体

- Noto Sans SC：https://fonts.google.com/noto/specimen/Noto+Sans+SC ，或 npm 包 `@fontsource/noto-sans-sc` 里的 ttf。
- Inter：https://fonts.google.com/specimen/Inter ，或 npm 包 `@fontsource/inter` 里的 ttf（选 `inter-latin-400-normal.ttf` / `inter-latin-700-normal.ttf` 并重命名为上表文件名）。

> Inter 只用于英文/数字，无需担心中文覆盖；但**不要**把 Inter 用在可能含中文的文本上，否则中文会渲染为空白（模板已按此约定分配字体）。

## 强烈建议：子集化（Subsetting）

完整的 Noto Sans SC 单个字重约 **10MB**，两个字重 20MB 会显著拖慢 Serverless 冷启动。用 `fonttools` 子集化到常用汉字（约 1–2MB）：

```bash
pip install fonttools

# 保留基本汉字区(U+4E00-9FFF) + ASCII + 常用符号
pyftsubset NotoSansSC-Regular.otf \
  --output-file=NotoSansSC-Regular.ttf \
  --flavor= \
  --unicodes=U+0000-00FF,U+4E00-9FFF,U+3000-303F,U+FF00-FFEF,U+2000-206F \
  --layout-features='*' --no-hinting

pyftsubset NotoSansSC-Bold.otf \
  --output-file=NotoSansSC-Bold.ttf \
  --flavor= \
  --unicodes=U+0000-00FF,U+4E00-9FFF,U+3000-303F,U+FF00-FFEF,U+2000-206F \
  --layout-features='*' --no-hinting
```

> 注意：`--flavor=` 留空生成裸 `.ttf`；不要用 `--flavor=woff2`，react-pdf 不认 woff2。
> Inter 本身很小（每字重约 300KB），一般无需子集化。

## Git 提交说明

字体文件较大，若不想入库可在 `.gitignore` 忽略 `public/fonts/*.ttf`，但**部署时必须保证这四个文件存在**，否则线上 PDF 会因 `ENOENT` 失败。本项目 `next.config.js` 的 `outputFileTracingIncludes` 已把 `public/fonts/**` 打进 Server 产物。
