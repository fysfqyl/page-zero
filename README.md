# 枫叶随风的博客

一个生活随笔博客：记城市、天气与物件里的小事。静态页面，没有框架，托管在 GitHub Pages。

线上地址：https://fysfqyl.github.io/page-zero/

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

## 本地预览

ES 模块在 `file://` 下加载不了，起一个静态服务器：

```
python -m http.server 8000
```

然后打开 http://localhost:8000/

## 目录

- `index.html` 首页（文章列表）
- `posts/p001.html` … `posts/p003.html` 三篇文章
- `404.html` 找不到页面的提示
- `assets/endfield.css` 界面套件（颜色、部件与动效）
- `assets/fx.js` 深浅切换与页面小动效
- `assets/variant.js` 外观设置（写在 `<html>` 上）
- `assets/site.css` 本站布局与自托管字体声明
- `assets/fonts/Saira.ttf` 界面拉丁字体，SIL OFL 1.1，许可证见 `assets/fonts/Saira-OFL.txt`；中文使用系统中文字体
- `scripts/count.py` 计算每篇文章正文的实际字符数，写入页面的字数与阅读时长

## 内容与数据

编号（No.001–No.003）按发布顺序；日期（2026.10.24）是三篇文章的实际发布日期；字数由 `scripts/count.py` 数出每篇正文（含小标题）去掉空白后的字符数，阅读时长按每分钟 400 字四舍五入。页面里没有编造的数字。

## 部署

仓库使用 GitHub Pages：分支 `main`、根目录。整站没有构建步骤，改完直接提交即可；`scripts/count.py` 只在新增文章后运行一次。
