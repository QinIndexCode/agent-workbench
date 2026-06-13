#!/usr/bin/env python3
"""
Logo PNG 压缩脚本
针对 Agent Workbench logo 图片的特点进行针对性压缩：
- 高分辨率 (1254x1254) 但内容简单（纯色 + 圆角矩形 + 几何图形）
- 透明背景 (RGBA)
- 仅使用两种颜色（黑/白主题互换）
- 边缘清晰，无渐变、无纹理

压缩策略：
1. 先用 oxipng 无损压缩（去除元数据、优化滤波器、优化 Huffman）
2. 若仍过大，用 pngquant 有损压缩（256色 palette，保留透明度）
3. 最终回退：转为 WebP（无损）
"""

import os
import sys
import subprocess
import shutil
from pathlib import Path

# 配置
INPUT_DIR = Path("d:/MyCode/myApp_/Scc_batch_web/apps/web/src/assets/logo")
OUTPUT_DIR = INPUT_DIR  # 直接覆盖或备份后覆盖
BACKUP_SUFFIX = ".original"

# 目标文件
FILES = [
    "logo-blackTheme.png",
    "logo-whiteTheme.png",
]


def get_file_size(path: Path) -> int:
    return path.stat().st_size


def format_size(size: int) -> str:
    if size < 1024:
        return f"{size} B"
    elif size < 1024 * 1024:
        return f"{size / 1024:.1f} KB"
    else:
        return f"{size / (1024 * 1024):.2f} MB"


def backup_original(path: Path) -> Path:
    backup = path.with_suffix(path.suffix + BACKUP_SUFFIX)
    if not backup.exists():
        shutil.copy2(path, backup)
        print(f"  已备份原文件: {backup.name}")
    return backup


def compress_with_oxipng(input_path: Path, output_path: Path) -> bool:
    """使用 oxipng 进行无损压缩。"""
    oxipng = shutil.which("oxipng")
    if not oxipng:
        print("  oxipng 未找到，跳过无损压缩阶段")
        return False

    # -o 4: 最高优化级别
    # --strip all: 移除所有元数据
    # --alpha: 优化透明通道
    cmd = [
        oxipng,
        "-o", "4",
        "--strip", "all",
        "--alpha",
        "--out", str(output_path),
        str(input_path)
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if result.returncode == 0:
            return True
        print(f"  oxipng 错误: {result.stderr}")
        return False
    except Exception as e:
        print(f"  oxipng 执行失败: {e}")
        return False


def compress_with_pngquant(input_path: Path, output_path: Path, quality: int = 100) -> bool:
    """使用 pngquant 进行有损压缩（palette 化）。"""
    pngquant = shutil.which("pngquant")
    if not pngquant:
        print("  pngquant 未找到，跳过量化压缩阶段")
        return False

    # --quality 100: 最高质量（视觉无损）
    # --speed 1: 最慢但最优
    # --nofs: 禁用 Floyd-Steinberg dithering（保持边缘锐利）
    # --force: 覆盖输出文件
    # -o: 输出路径
    cmd = [
        pngquant,
        f"--quality={quality}",
        "--speed", "1",
        "--nofs",
        "--force",
        "--output", str(output_path),
        str(input_path)
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        # pngquant 返回码 0 或 98（质量未达到目标但已输出）都算成功
        if result.returncode in (0, 98):
            return True
        print(f"  pngquant 错误: {result.stderr}")
        return False
    except Exception as e:
        print(f"  pngquant 执行失败: {e}")
        return False


def compress_with_pillow(input_path: Path, output_path: Path) -> bool:
    """使用 Pillow 进行 Python 原生压缩（作为回退方案）。"""
    try:
        from PIL import Image
        img = Image.open(input_path)

        # 对于纯色 logo，尝试转换为 P mode（palette）+ 透明
        if img.mode == "RGBA":
            # 使用 Fast Octree 方法量化到 256 色，保留透明度
            img = img.quantize(colors=256, method=Image.Quantize.FASTOCTREE)

        img.save(
            output_path,
            "PNG",
            optimize=True,
            compress_level=9,
        )
        return True
    except Exception as e:
        print(f"  Pillow 压缩失败: {e}")
        return False


def compress_file(filename: str) -> None:
    input_path = INPUT_DIR / filename
    if not input_path.exists():
        print(f"文件不存在: {input_path}")
        return

    original_size = get_file_size(input_path)
    print(f"\n处理: {filename}")
    print(f"  原始大小: {format_size(original_size)}")

    # 备份原文件
    backup_original(input_path)

    # 阶段 1: oxipng 无损压缩
    temp_path = input_path.with_suffix(".tmp.png")
    print("  阶段 1: oxipng 无损压缩...")
    if compress_with_oxipng(input_path, temp_path):
        stage1_size = get_file_size(temp_path)
        reduction = (1 - stage1_size / original_size) * 100
        print(f"  阶段 1 完成: {format_size(stage1_size)} (-{reduction:.1f}%)")

        # 如果已经压缩到足够小（<100KB），直接采用
        if stage1_size < 100 * 1024:
            shutil.move(temp_path, input_path)
            print(f"  最终大小: {format_size(stage1_size)} (采用 oxipng 结果)")
            return
    else:
        # oxipng 失败，复制原文件到 temp
        shutil.copy2(input_path, temp_path)

    # 阶段 2: pngquant 有损压缩（视觉无损）
    print("  阶段 2: pngquant 量化压缩 (256色, 无dithering)...")
    temp_path2 = input_path.with_suffix(".tmp2.png")
    if compress_with_pngquant(temp_path, temp_path2, quality=100):
        stage2_size = get_file_size(temp_path2)
        reduction = (1 - stage2_size / original_size) * 100
        print(f"  阶段 2 完成: {format_size(stage2_size)} (-{reduction:.1f}%)")

        # 清理临时文件
        if temp_path.exists():
            temp_path.unlink()
        shutil.move(temp_path2, input_path)
        print(f"  最终大小: {format_size(stage2_size)}")
        return
    else:
        if temp_path2.exists():
            temp_path2.unlink()

    # 阶段 3: Pillow 回退
    print("  阶段 3: Pillow 原生压缩...")
    if compress_with_pillow(input_path, temp_path):
        stage3_size = get_file_size(temp_path)
        reduction = (1 - stage3_size / original_size) * 100
        print(f"  阶段 3 完成: {format_size(stage3_size)} (-{reduction:.1f}%)")
        shutil.move(temp_path, input_path)
        print(f"  最终大小: {format_size(stage3_size)}")
        return

    # 全部失败，恢复备份
    print("  所有压缩方法均失败，恢复原始文件")
    backup = input_path.with_suffix(input_path.suffix + BACKUP_SUFFIX)
    if backup.exists():
        shutil.copy2(backup, input_path)

    # 清理临时文件
    for p in [temp_path, temp_path2]:
        if p.exists():
            p.unlink()


def main():
    print("=" * 60)
    print("Agent Workbench Logo PNG 压缩工具")
    print("=" * 60)
    print(f"输入目录: {INPUT_DIR}")
    print(f"文件: {', '.join(FILES)}")
    print()

    # 检查依赖
    has_oxipng = shutil.which("oxipng") is not None
    has_pngquant = shutil.which("pngquant") is not None
    has_pillow = False
    try:
        from PIL import Image
        has_pillow = True
    except ImportError:
        pass

    print("可用工具:")
    print(f"  oxipng:   {'✓' if has_oxipng else '✗'}")
    print(f"  pngquant: {'✓' if has_pngquant else '✗'}")
    print(f"  Pillow:   {'✓' if has_pillow else '✗'}")
    print()

    if not any([has_oxipng, has_pngquant, has_pillow]):
        print("错误: 未找到任何压缩工具。请安装以下工具之一:")
        print("  - oxipng:   cargo install oxipng")
        print("  - pngquant: npm install -g pngquant-bin")
        print("  - Pillow:   pip install Pillow")
        sys.exit(1)

    total_original = 0
    total_final = 0

    for filename in FILES:
        input_path = INPUT_DIR / filename
        if input_path.exists():
            total_original += get_file_size(input_path)
            compress_file(filename)
            total_final += get_file_size(input_path)
        else:
            print(f"\n跳过: {filename} (文件不存在)")

    print("\n" + "=" * 60)
    print("压缩汇总")
    print("=" * 60)
    print(f"原始总大小: {format_size(total_original)}")
    print(f"最终总大小: {format_size(total_final)}")
    if total_original > 0:
        reduction = (1 - total_final / total_original) * 100
        print(f"总体压缩率: -{reduction:.1f}%")
    print()
    print("原文件已备份为 *.original，如需恢复请手动重命名")


if __name__ == "__main__":
    main()
