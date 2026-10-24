# -*- coding: utf-8 -*-
"""count.py — 数出每篇文章正文的实际字符数，写回页面的字数与阅读时长。

口径：<div class="ef-prose"> 里的文字（含小标题）去掉全部空白后的字符数。
阅读时长 = 字数 / 400，四舍五入，至少 1 分钟。
占位符 {{count}} {{minutes}} {{p1}} {{p2}} {{p3}} {{total}} 会被替换成真实数字。
分两遍：先数完所有文章，再回填（文章之间互相引用，顺序无关）。
"""
import io
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
POSTS = {
    'p1': 'posts/p001.html',
    'p2': 'posts/p002.html',
    'p3': 'posts/p003.html',
}


def prose_text(html):
    m = re.search(r'<div class="ef-prose">(.*?)</div>', html, re.S)
    body = m.group(1) if m else ''
    body = re.sub(r'<[^>]+>', '', body)
    return ''.join(body.split())


def fmt(n):
    return format(n, ',')


def read(path):
    with io.open(path, encoding='utf-8') as f:
        return f.read()


def write(path, text):
    with io.open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)


# 第一遍：只数数
counts = {}
for key, rel in POSTS.items():
    counts[key] = len(prose_text(read(os.path.join(ROOT, rel))))
    print('%s : %d chars' % (rel, counts[key]))

# 第二遍：回填
for key, rel in POSTS.items():
    path = os.path.join(ROOT, rel)
    html = read(path)
    n = counts[key]
    html = html.replace('{{count}}', fmt(n)).replace('{{minutes}}', str(max(1, round(n / 400.0))))
    for k, v in counts.items():
        html = html.replace('{{%s}}' % k, fmt(v))
    write(path, html)
    print('%s : patched (%d chars, %d min)' % (rel, n, max(1, round(n / 400.0))))

total = sum(counts.values())
index_path = os.path.join(ROOT, 'index.html')
html = read(index_path)
for k, v in counts.items():
    html = html.replace('{{%s}}' % k, fmt(v))
html = html.replace('{{total}}', fmt(total))
write(index_path, html)
print('index : patched, total %d chars' % total)
