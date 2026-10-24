# 枫叶随风的博客

一个生活随笔博客：记城市、天气与物件里的小事。静态页面，没有框架，托管在 GitHub Pages。

线上地址：https://fysfqyl.github.io/page-zero/
后台地址：https://fysfqyl.github.io/page-zero/admin.html

## 设计说明

```
变体：标准（yellow / neutral / standard / contours / standard / full）
主视觉：首页首屏是「// RECENT NOTES / 最近记录」下的编号记录列表，最新一篇的编号是黄色
页面类型：阅读（首页列表与文章页都是阅读页）
```

- 只用一种强调色 `#FFFA00`，只表示当前位置、可点击内容、醒目提醒；红色只留给删除
- 切掉一个角的块 = 可以点；正文、栏目都是直角，圆角一律为 0
- 英文小字全大写、拉宽，中文黑体加粗；编号、日期、字数都是真实数据
- 细线分区，不用投影、发光、渐变；动效短、硬、机械
- 浅色、深色两套主题；系统开启“减少动态效果”后所有动效静止

## 写文章：后台

打开 `/admin.html`，第一次要粘一个 GitHub 令牌（口令）。之后这台设备会记住它，直到你在后台点“退出”。

- **写新文章** → 标题、分类、导语、正文（可视化编辑，工具栏有小标题、粗体、引用、列表）→ 发布文章
- **改文章** → 列表里点“编辑”，正文会从现有页面上读回来，改完保存
- **删文章** → 列表里点“删除”，确认后文章和索引一起删掉
- **预览** → 不提交也能看到文章页的真实排版
- 保存 = 提交一次 commit（`posts/pNNN.html` + `posts/index.json` 一起写），GitHub Pages 自动重建，约 1 分钟后上线

后台不需要服务器：浏览器拿着令牌直接调 GitHub API。令牌只存在浏览器 localStorage，不会写进仓库，也不会出现在任何页面源码里。

### 令牌怎么建

1. GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token
2. Repository access：Only select repositories → 只勾 `page-zero`
3. Permissions → Repository permissions → **Contents: Read and write**
4. Expiration 选一个过期时间（例如 90 天）→ Generate → 复制 `github_pat_…`
5. 粘到后台的登录框里。令牌只显示一次，丢了就重新生成，后台“退出”后随时可以换新的

### 数据从哪来

`posts/index.json` 是首页列表的唯一数据源（编号、标题、日期、分类、字数）。后台每次保存都会重写它，所以首页的数字永远是对的。如果直接在 GitHub 上改了某篇文章的 HTML，回后台点一次“重建索引”，它会扫描 `posts/*.html` 把索引重新算出来。

文章页是完整的静态 HTML，由后台的 `assets/admin.js` 生成；正文段落会被规范成 `<p>`、小标题是 `<h2>`，和原来的手写页面同一套结构。

## 本地预览

ES 模块在 `file://` 下加载不了，起一个静态服务器：

```
python -m http.server 8000
```

然后打开 http://localhost:8000/ 。注意 `fetch('./posts/index.json')` 也需要 http。

## 目录

- `index.html` 首页（文章列表；读取 `posts/index.json` 渲染，页面里保留了没开 JS 时的静态列表）
- `admin.html` 后台（登录、列表、编辑器、预览框）
- `posts/pNNN.html` 每篇文章的静态页面
- `posts/index.json` 文章索引：编号、标题、日期、分类、字数
- `404.html` 找不到页面的提示
- `assets/endfield.css` 界面套件（颜色、部件与动效）
- `assets/fx.js` 深浅切换与页面小动效
- `assets/variant.js` 外观设置（写在 `<html>` 上）
- `assets/site.css` 本站布局与自托管字体声明
- `assets/admin.js` 后台逻辑：GitHub API 读写、文章页面生成、正文清洗
- `assets/fonts/Saira.ttf` 界面拉丁字体，SIL OFL 1.1，许可证见 `assets/fonts/Saira-OFL.txt`；中文使用系统中文字体
- `scripts/count.py` 早期用来数正文里 `{{count}}` 占位符的脚本，现在字数由后台直接算（口径相同：正文含小标题、去掉空白后的字符数，阅读时长按每分钟 400 字四舍五入）

## 内容与数据

编号按发布顺序递增；日期是文章的实际发布日期；字数由后台按正文（含小标题）去掉空白后的字符数算出，阅读时长按每分钟 400 字四舍五入。首页的合计篇数、合计字数、分类统计都由索引现算。

## 部署

仓库使用 GitHub Pages：分支 `main`、根目录。整站没有构建步骤，改完直接提交即可。`.nojekyll` 让 Pages 跳过 Jekyll，避免正文里出现 `{{` 之类字符时构建失败。
