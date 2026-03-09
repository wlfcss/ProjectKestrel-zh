#!/usr/bin/env python3
"""
Build logo files from logo.svg

Converts SVG to:
- .ico file
- PNG at various sizes
- Microsoft Store app package files

Requires: cairosvg, Pillow, lxml
"""

import os
import sys
import subprocess
from pathlib import Path
import xml.etree.ElementTree as ET

try:
    from PIL import Image
except ImportError:
    print("Installing Pillow...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "Pillow"])
    from PIL import Image

try:
    import cairosvg
except ImportError:
    print("Installing cairosvg...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "cairosvg"])
    import cairosvg


SCRIPT_DIR = Path(__file__).parent.absolute()
ASSETS_DIR = SCRIPT_DIR
SVG_PATH = ASSETS_DIR / "logo.svg"
ANALYZER_DIR = ASSETS_DIR.parent / "analyzer"

# Microsoft Store and output file specs: (filename, width, height, bg_color)
# bg_color: None = transparent, tuple = (R, G, B)
# Squares are filled with background color to maintain square aspect ratio
OUTPUT_SPECS = [
    # Root-level PNG (transparent background)
    ("logo.png", 2048, 2048, None),
    
    # Microsoft Store - Square sizes (transparent background)
    ("Squares/Square44x44Logo.png", 44, 44, None),
    ("Squares/Square150x150Logo.png", 150, 150, None),
    ("Squares/Square310x310Logo.png", 310, 310, None),
    
    # Microsoft Store - Wide format (transparent background)
    ("Wide310x150Logo.png", 310, 150, None),
    
    # Microsoft Store - Store logo (transparent background)
    ("StoreLogo.png", 50, 50, None),
    
    # Splash screen (dark blue background)
    ("SplashScreen.png", 1116, 540, None),
]

# ICO file spec (transparent background)
ICO_SPEC = ("logo.ico", 256)
ICO_RENDER_SIZE = 512  # render at larger size for better quality in .ico format


def crop_svg_to_content(svg_path):
    """
    Crop SVG viewBox to its content bounds by rendering and detecting non-transparent pixels.
    Returns modified SVG content as string.
    """
    print("  Cropping SVG to content...")
    
    # First, render SVG to image to detect actual content bounds
    temp_render = svg_path.with_stem(svg_path.stem + "_render")
    try:
        cairosvg.svg2png(
            url=str(svg_path),
            write_to=str(temp_render),
            output_width=2048,  # render at high resolution
            output_height=2048,
        )
    except Exception:
        # If render fails, fall back to original viewBox
        print("    (rendering failed, using original viewBox)")
        return None
    
    # Analyze the rendered image to find content bounds
    try:
        img = Image.open(temp_render).convert("RGBA")
        pixels = img.load()
        width, height = img.size
        
        min_x, min_y = width, height
        max_x, max_y = 0, 0
        found_content = False
        
        # Find bounds of non-transparent pixels
        for y in range(height):
            for x in range(width):
                r, g, b, a = pixels[x, y]
                if a > 1:  # treat pixels with alpha > 10 as content
                    found_content = True
                    min_x = min(min_x, x)
                    min_y = min(min_y, y)
                    max_x = max(max_x, x)
                    max_y = max(max_y, y)
        
        temp_render.unlink()
        
        if not found_content:
            print("    (no content detected, using original viewBox)")
            return None
        
        # Convert rendered image bounds back to SVG viewBox scale
        # Parse original viewBox
        tree = ET.parse(svg_path)
        root = tree.getroot()
        old_viewBox = root.get('viewBox', '0 0 612 792')
        vb_parts = old_viewBox.split()
        vb_x, vb_y, vb_w, vb_h = map(float, vb_parts)
        
        # Calculate scale factors
        scale_x = vb_w / width
        scale_y = vb_h / height
        
        # Convert pixel bounds to viewBox coordinates
        content_x = vb_x + min_x * scale_x
        content_y = vb_y + min_y * scale_y
        content_w = (max_x - min_x + 1) * scale_x
        content_h = (max_y - min_y + 1) * scale_y
        
        # Add padding (15% of content size to prevent edge cutoff)
        padding_x = content_w * 0.15
        padding_y = content_h * 0.15
        
        new_x = content_x - padding_x
        new_y = content_y - padding_y
        new_w = content_w + 2 * padding_x
        new_h = content_h + 2 * padding_y
        
        # Update viewBox
        new_viewBox = f"{new_x} {new_y} {new_w} {new_h}"
        root.set('viewBox', new_viewBox)
        
        # Convert back to string
        svg_content = ET.tostring(root, encoding='unicode')
        print(f"    ✓ Cropped: {old_viewBox} → {new_viewBox}")
        return svg_content
        
    except Exception as e:
        print(f"    (error detecting bounds: {e}, using original viewBox)")
        if temp_render.exists():
            temp_render.unlink()
        return None


def svg_to_png(svg_path_or_content, png_path, width, height, bg_color=None, use_svg_string=False):
    """
    Convert SVG to PNG with padding to fit exact dimensions while maintaining aspect ratio.
    bg_color: None = transparent, tuple = (R, G, B)
    """
    print(f"  Converting to {png_path} ({width}x{height})...")
    
    # Create intermediate PNG at a larger size first
    temp_png = png_path.with_stem(png_path.stem + "_temp")
    
    # Render SVG at 2x scale for better quality
    render_width = width * 2
    render_height = int(render_width * 792 / 612)  # maintain SVG aspect ratio (612x792)
    
    # Convert SVG to PNG (transparent background for render)
    if use_svg_string:
        # Write string to temp file for cairosvg to read
        temp_svg = png_path.with_stem(png_path.stem + "_temp.svg")
        with open(temp_svg, 'w', encoding='utf-8') as f:
            f.write(svg_path_or_content)
        cairosvg.svg2png(
            url=str(temp_svg),
            write_to=str(temp_png),
            output_width=render_width,
            output_height=render_height,
        )
        temp_svg.unlink()
    else:
        cairosvg.svg2png(
            url=str(svg_path_or_content),
            write_to=str(temp_png),
            output_width=render_width,
            output_height=render_height,
        )
    
    # Load the rendered image
    img = Image.open(temp_png).convert("RGBA")
    
    # Create background
    if bg_color is None:
        # Transparent background
        background = Image.new("RGBA", (width * 2, height * 2), (0, 0, 0, 0))
        has_alpha = True
    else:
        # Solid background color
        background = Image.new("RGBA", (width * 2, height * 2), bg_color + (255,))
        has_alpha = False
    
    # Calculate scaling to fit the image within the target size while maintaining aspect ratio
    img_width, img_height = img.size
    target_width, target_height = width * 2, height * 2
    
    # Scale to fit
    scale = min(target_width / img_width, target_height / img_height)
    new_width = int(img_width * scale)
    new_height = int(img_height * scale)
    img = img.resize((new_width, new_height), Image.Resampling.LANCZOS)
    
    # Paste onto background (centered)
    x = (target_width - new_width) // 2
    y = (target_height - new_height) // 2
    background.paste(img, (x, y), img)
    
    # Downscale back to target size for better quality
    final = background.resize((width, height), Image.Resampling.LANCZOS)
    
    # Save based on whether we need alpha channel
    if has_alpha:
        final.save(png_path, "PNG")
    else:
        final = final.convert("RGB")
        final.save(png_path, "PNG")
    
    # Clean up temp file
    temp_png.unlink()
    print(f"    ✓ {png_path}")


def png_to_ico(png_path, ico_path, size):
    """Convert PNG to ICO file with transparency."""
    print(f"  Converting to {ico_path}...")
    img = Image.open(png_path).convert("RGBA")
    img = img.resize((size, size), Image.Resampling.LANCZOS)
    img.save(ico_path, "ICO")
    print(f"    ✓ {ico_path}")


def main():
    if not SVG_PATH.exists():
        print(f"Error: {SVG_PATH} not found!")
        return False
    
    print(f"Building logo files from: {SVG_PATH}\n")
    
    # Create output directories
    (ASSETS_DIR / "Squares").mkdir(exist_ok=True)
    print("✓ Output directories ready\n")
    
    # Crop SVG to content
    print("Cropping SVG...")
    cropped_svg = crop_svg_to_content(SVG_PATH)
    print()
    
    # Generate PNGs
    print("Generating PNG files...")
    for filename, width, height, bg_color in OUTPUT_SPECS:
        output_path = ASSETS_DIR / filename
        svg_to_png(
            cropped_svg if cropped_svg else SVG_PATH,
            output_path,
            width,
            height,
            bg_color,
            use_svg_string=bool(cropped_svg)
        )
    
    print("\nGenerating ICO file (transparent background)...")
    ico_path = ASSETS_DIR / ICO_SPEC[0]
    
    # Create ICO source at larger size for better quality
    print(f"  Creating high-quality render for ICO...")
    temp_ico_png = ASSETS_DIR / "logo_ico_temp.png"
    svg_to_png(
        cropped_svg if cropped_svg else SVG_PATH,
        temp_ico_png,
        ICO_RENDER_SIZE,
        ICO_RENDER_SIZE,
        None,  # transparent background
        use_svg_string=bool(cropped_svg)
    )
    png_to_ico(temp_ico_png, ico_path, ICO_SPEC[1])
    temp_ico_png.unlink()
    
    print("\nCopying files to analyzer directory...")
    import shutil
    
    files_to_copy = [ico_path, SVG_PATH]
    for src in files_to_copy:
        dst = ANALYZER_DIR / src.name
        shutil.copy2(src, dst)
        print(f"  ✓ Copied {src.name} to {ANALYZER_DIR}")
    
    print("\n✅ All done! Logo files have been generated.")
    return True


if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)
