#!/usr/bin/env python3
"""生成扩展图标（16/32/48/128 四个尺寸）。

设计：蓝色圆角底 + 白色二维码定位角（QR finder pattern），右下角切掉一个转角。

为什么画定位角而不是完整二维码：图标在工具栏里最小只有 16px，完整二维码的
模块网格在该尺寸下必然糊成噪点；定位角（方环 + 中心实心方块）是二维码轮廓
里最强的特征，缩到 16px 仍然读得出来。

为什么右下角切掉一个转角：完整的定位角与市面上多数二维码工具图标同形，切掉
转角既延续了二维码「模块拼合」的语言，又给轮廓一个不对称的落点。缺口边长就
等于环厚，切掉的正好是环的一个转角，两条臂各自收在中心方块的外沿上，因此
切口天然与内框对齐，也不会在角上留下细碎的白边。

为什么 16px 不画切口：该尺寸环厚只有 2px，切完剩一个 2px 的断口，更像缺角
瑕疵而不是设计意图；小尺寸只保留完整的定位角。

为什么每个尺寸单独给一组整数像素参数：直接按 128px 的几何等比缩放，环厚会
落在 2.07px、1.64px 这类非整数值上，抗锯齿把环涂成灰蓝色，16px 必然发虚。
四个尺寸共用同一套比例，但各自取整到该尺寸的像素网格，边缘就能落在像素边界
上——这是图标适配的常规做法，也是本脚本逐个尺寸列参数、而不是只写一套的原因。

为什么手写 PNG 而不依赖 Pillow：扩展本身零运行时依赖，构建脚本也保持零依赖，
任何 Python 3 环境都能复现同一批图标。

用法：python tools/make-icons.py
"""

import os
import struct
import zlib

DESIGN = 128.0        # 设计稿坐标系边长；所有几何参数都以它为基准
SUPERSAMPLE = 8       # 超采样倍数：缩回目标尺寸时起抗锯齿作用
CORNER_RADIUS = 26.0  # 底版圆角半径（圆角本身需要抗锯齿，不做像素取整）

# 每个尺寸一组几何参数，单位是该尺寸本身的像素。数值都取整，理由见模块文档。
# box 是定位角外框，ring 是环厚，core 是中心方块边长，cut 表示是否切掉右下转角。
GEOMETRY = {
    16: dict(box=(2.0, 2.0, 14.0, 14.0), ring=2.0, core=4.0, cut=False),
    32: dict(box=(4.0, 4.0, 28.0, 28.0), ring=4.0, core=8.0, cut=True),
    48: dict(box=(6.0, 6.0, 42.0, 42.0), ring=6.0, core=12.0, cut=True),
    128: dict(box=(18.0, 18.0, 110.0, 110.0), ring=17.0, core=32.0, cut=True),
}

SIZES = (16, 32, 48, 128)

BG_TOP = (66, 128, 243)    # 与面板 --accent (#2563eb) 同族，取亮一档作渐变起点
BG_BOTTOM = (30, 76, 208)  # 右下压暗，给纯色底一点体积感
WHITE = (255, 255, 255)


def inside_rounded_rect(u, v):
    """圆角矩形的距离场：把点投影到内缩后的矩形，再判断是否落在圆角内。"""
    dx = max(abs(u - DESIGN / 2) - (DESIGN / 2 - CORNER_RADIUS), 0.0)
    dy = max(abs(v - DESIGN / 2) - (DESIGN / 2 - CORNER_RADIUS), 0.0)
    return dx * dx + dy * dy <= CORNER_RADIUS * CORNER_RADIUS


def gradient(u, v):
    """对角渐变：沿左上到右下的方向插值，比纯竖向渐变更有光感。"""
    t = max(0.0, min(1.0, (u * 0.35 + v * 0.65) / DESIGN))
    return tuple(round(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOTTOM))


def make_mark_test(size):
    """返回判定「该点是否落在白色定位角上」的闭包（入参为设计稿坐标）。

    定位角 = 外框减去内框（得到环）+ 中心方块；cut 为真时再从环上挖掉右下
    转角，缺口边长等于环厚，切口因此与内框角点严丝合缝。
    """
    spec = GEOMETRY[size]
    scale = DESIGN / size  # 该尺寸的像素 → 设计稿坐标
    x0, y0, x1, y1 = (value * scale for value in spec["box"])
    ring = spec["ring"] * scale
    core = spec["core"] * scale
    notch = ring if spec["cut"] else 0.0

    inner = (x0 + ring, y0 + ring, x1 - ring, y1 - ring)
    half = core / 2
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    core_box = (cx - half, cy - half, cx + half, cy + half)

    def in_rect(u, v, box):
        return box[0] <= u <= box[2] and box[1] <= v <= box[3]

    def test(u, v):
        if in_rect(u, v, (x0, y0, x1, y1)) and not in_rect(u, v, inner):
            if notch and u > x1 - notch and v > y1 - notch:
                return False
            return True
        return in_rect(u, v, core_box)

    return test


def resolve_samples(accumulator):
    """把每个像素内 SS×SS 个采样点合成为一个 RGBA 像素。

    底版外没有任何贡献，累加值里 alpha 为 0；底版内每个采样点都按
    alpha=255 累加，所以 alpha 之和本身就能反推出有效采样数。
    先按有效采样数平均颜色，再单独计算覆盖率，圆角边缘才不会出现暗边。
    """
    total = SUPERSAMPLE * SUPERSAMPLE
    rows = []
    for row in accumulator:
        out = []
        for r, g, b, a in row:
            if a == 0:
                out.append((0, 0, 0, 0))
                continue
            count = a // 255
            out.append((r // count, g // count, b // count, a // total))
        rows.append(out)
    return rows


def render(size):
    big = size * SUPERSAMPLE
    step = DESIGN / big
    xs = [(x + 0.5) * step for x in range(big)]
    accum = [[[0, 0, 0, 0] for _ in range(size)] for _ in range(size)]

    mark = make_mark_test(size)

    def sample(u, v):
        """返回一个超采样点的颜色；落在圆角底版之外时返回 None。"""
        if not inside_rounded_rect(u, v):
            return None
        return WHITE if mark(u, v) else gradient(u, v)

    for py in range(big):
        v = min(DESIGN, max(0.0, (py + 0.5) * step))
        cells = accum[py // SUPERSAMPLE]
        for px in range(big):
            color = sample(xs[px], v)
            if color is None:
                continue
            cell = cells[px // SUPERSAMPLE]
            cell[0] += color[0]
            cell[1] += color[1]
            cell[2] += color[2]
            cell[3] += 255

    return resolve_samples(accum)


def encode_png(rows):
    height, width = len(rows), len(rows[0])
    raw = b"".join(
        b"\x00" + b"".join(struct.pack("BBBB", *pixel) for pixel in row) for row in rows
    )

    def chunk(tag, data):
        payload = tag + data
        return struct.pack(">I", len(data)) + payload + struct.pack(">I", zlib.crc32(payload) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def main():
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir)
    out_dir = os.path.join(root, "icons")
    os.makedirs(out_dir, exist_ok=True)
    for size in SIZES:
        path = os.path.join(out_dir, "icon%d.png" % size)
        with open(path, "wb") as handle:
            handle.write(encode_png(render(size)))
        print("wrote %s (%d bytes)" % (path, os.path.getsize(path)))


if __name__ == "__main__":
    main()
