#!/usr/bin/env python3
"""Project Kestrel 的 XMP 元数据写入工具。

该模块会在原图旁写出 ``.xmp`` 旁车文件，写入星级评分、筛片标签
以及分析元数据（物种、科、质量分数），兼容 Adobe Lightroom、
darktable 和 Capture One。
"""

import os
import sys

from taxonomy_utils import family_display_name, species_display_name

# XMP 命名空间 URI
_KESTREL_NS = 'http://ns.projectkestrel.app/xmp/1.0/'
_NS_RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'
_NS_XMP = 'http://ns.adobe.com/xap/1.0/'
_NS_DC = 'http://purl.org/dc/elements/1.1/'
_NS_LR = 'http://ns.adobe.com/lightroom/1.0/'

# 表示“没有有效识别结果”的物种/科占位值
_EMPTY_LABELS = {'', 'unknown', 'no bird'}
_EMPTY_LABELS.update({'未知', '无鸟', '不适用', '未知科'})


def log(*args):
    """把日志写到 stderr，并带上 [metadata] 前缀。"""
    print('[metadata]', *args, file=sys.stderr)


def _xml_escape(text: str) -> str:
    """转义 XML 属性和值中的特殊字符。"""
    return (
        text.replace('&', '&amp;')
        .replace('<', '&lt;')
        .replace('>', '&gt;')
        .replace('"', '&quot;')
        .replace("'", '&apos;')
    )


def _is_meaningful(value: str) -> bool:
    """如果字符串标签代表真实识别结果，而不是空值/未知值，则返回 True。"""
    return bool(value) and value.lower() not in _EMPTY_LABELS


def _build_xmp_packet(
    rating: int,
    label: str,
    cull_status: str,
    filename: str,
    species: str = '',
    family: str = '',
    quality_score: float = -1.0,
) -> str:
    """构建完整的 XMP 数据包字符串，包含评分、标签和 Kestrel 元数据。"""
    rating = max(0, min(5, rating))
    has_species = _is_meaningful(species)
    has_family = _is_meaningful(family)
    has_quality = quality_score >= 0.0

    lines = [
        '<?xpacket begin="\xef\xbb\xbf" id="W5M0MpCehiHzreSzNTczkc9d"?>',
        '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
        f'  <rdf:RDF xmlns:rdf="{_NS_RDF}">',
        '    <rdf:Description rdf:about=""',
        f'      xmlns:xmp="{_NS_XMP}"',
        f'      xmlns:dc="{_NS_DC}"',
        f'      xmlns:lr="{_NS_LR}"',
        f'      xmlns:kestrel="{_KESTREL_NS}"',
        f'      xmp:Rating="{rating}"',
    ]

    if label:
        lines.append(f'      xmp:Label="{label}"')

    # Kestrel 自定义属性
    lines.append(f'      kestrel:CullStatus="{_xml_escape(cull_status)}"')
    lines.append(f'      kestrel:SourceFile="{_xml_escape(filename)}"')
    if has_species:
        lines.append(f'      kestrel:Species="{_xml_escape(species)}"')
    if has_family:
        lines.append(f'      kestrel:Family="{_xml_escape(family)}"')
    if has_quality:
        lines.append(f'      kestrel:QualityScore="{quality_score:.4f}"')

    lines.append('    >')

    # dc:description：写入 Lightroom 元数据面板可见的人类可读摘要
    desc_parts = []
    if has_species:
        desc_parts.append(f'Species: {species}')
    if has_family:
        desc_parts.append(f'Family: {family}')
    if has_quality:
        desc_parts.append(f'Quality: {quality_score:.3f}')
    desc_parts.append(f'Rating: {"*" * rating}')

    description = ' | '.join(desc_parts)
    lines += [
        '      <dc:description>',
        '        <rdf:Alt>',
        f'          <rdf:li xml:lang="x-default">{_xml_escape(description)}</rdf:li>',
        '        </rdf:Alt>',
        '      </dc:description>',
    ]

    # dc:subject：写入 Lightroom 关键词面板可见的层级关键词
    lines += [
        '      <dc:subject>',
        '        <rdf:Bag>',
        f'          <rdf:li>Kestrel|Rating|{rating} Star</rdf:li>',
    ]
    if has_species:
        lines.append(f'          <rdf:li>Kestrel|Species|{_xml_escape(species)}</rdf:li>')
    if has_family:
        lines.append(f'          <rdf:li>Kestrel|Family|{_xml_escape(family)}</rdf:li>')
    lines += [
        '        </rdf:Bag>',
        '      </dc:subject>',
        '    </rdf:Description>',
        '  </rdf:RDF>',
        '</x:xmpmeta>',
        '<?xpacket end="w"?>',
    ]

    return '\n'.join(lines)


def _is_kestrel_xmp(path: str) -> bool:
    """如果 ``path`` 指向的 XMP 文件由 Kestrel 写出，则返回 True。"""
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as f:
            content = f.read(4096)  # 命名空间声明通常出现在文件开头
        return _KESTREL_NS in content
    except Exception:
        return False


def write_xmp_metadata(root_path: str, image_data, overwrite_external: bool = False, use_auto_labels: bool = False):
    """为每张图片写入 XMP 旁车文件。

    写入内容包括星级评分、筛片标签，以及分析元数据（物种、科、质量分数）。

    ``image_data`` 中的每个元素都应是一个字典，至少支持以下字段：
        filename       裸文件名，例如 ``IMG_0001.jpg``
        rating         0-5 的整数评分
        culled         ``accept`` 或 ``reject``
        culled_origin  ``auto``、``manual`` 或 ``verified``（可选）
        species        识别得到的物种名（可选）
        family         识别得到的科名（可选）
        quality        0.0–1.0 的原始质量分数（可选）

    旁车文件会以 ``<basename>.xmp`` 的形式写在 ``root_path`` 下原图旁边。

    安全规则：
      - 如果已有的 ``.xmp`` 文件由 Kestrel 写出，则始终允许覆盖；
      - 如果已有的 ``.xmp`` 文件来自其他软件，而 ``overwrite_external`` 为 False，
        则跳过写入，并把文件名加入 ``skipped_conflicts``；
      - 如果 ``overwrite_external`` 为 True，则允许覆盖其他软件生成的 XMP。

    参数：
        root_path: 图片所在目录。
        image_data: 图片数据字典列表。
        overwrite_external: 是否覆盖非 Kestrel 生成的 XMP。
        use_auto_labels: 是否为 AI 自动筛片结果写入红/绿颜色标签。
            用户手动筛片（``manual`` / ``verified``）始终会写入标签。

    返回：
        ``{ success, written, skipped_conflicts: [filenames], errors }``
    """
    try:
        if not root_path or not os.path.isdir(root_path):
            return {'success': False, 'error': 'Invalid root path'}

        written = 0
        skipped_conflicts = []
        errors = []

        for entry in (image_data or []):
            try:
                filename = str(entry.get('filename', '')).strip()
                if not filename:
                    errors.append('(blank filename): skipped')
                    continue

                rating = int(entry.get('rating', 0) or 0)
                rating = max(0, min(5, rating))

                cull_status = str(entry.get('culled', '')).lower()
                origin = str(entry.get('culled_origin', '')).lower()
                
                label = ''
                if use_auto_labels or origin in ('manual', 'verified'):
                    if cull_status == 'accept':
                        label = 'Green'
                    elif cull_status == 'reject':
                        label = 'Red'

                species = species_display_name(str(entry.get('species', '') or '').strip())
                family = family_display_name(str(entry.get('family', '') or '').strip())

                quality_raw = entry.get('quality', None)
                try:
                    quality_score = float(quality_raw) if quality_raw is not None else -1.0
                except (TypeError, ValueError):
                    quality_score = -1.0

                base, _ext = os.path.splitext(filename)
                xmp_filename = base + '.xmp'
                xmp_path = os.path.join(root_path, xmp_filename)

                # 安全检查：如果 XMP 已存在，先确认它是不是 Kestrel 生成的
                if os.path.exists(xmp_path):
                    if not _is_kestrel_xmp(xmp_path):
                        if not overwrite_external:
                            skipped_conflicts.append(xmp_filename)
                            log(f'write_xmp: skipping external XMP {xmp_path}')
                            continue
                        else:
                            log(f'write_xmp: overwriting external XMP {xmp_path} (user confirmed)')

                xmp_content = _build_xmp_packet(
                    rating=rating,
                    label=label,
                    cull_status=cull_status,
                    filename=filename,
                    species=species,
                    family=family,
                    quality_score=quality_score,
                )

                tmp_xmp = xmp_path + '.tmp'
                with open(tmp_xmp, 'w', encoding='utf-8') as f:
                    f.write(xmp_content)
                os.replace(tmp_xmp, xmp_path)

                written += 1
                log(f'write_xmp: wrote {xmp_path}')

            except Exception as entry_err:
                errors.append(f'{entry.get("filename", "?")}: {entry_err}')

        log(f'write_xmp_metadata: written={written}, conflicts={len(skipped_conflicts)}, errors={len(errors)}')
        return {
            'success': True,
            'written': written,
            'skipped_conflicts': skipped_conflicts,
            'errors': errors,
        }

    except Exception as e:
        log(f'write_xmp_metadata error: {e}')
        return {'success': False, 'error': str(e)}
