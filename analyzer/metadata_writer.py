#!/usr/bin/env python3
"""XMP metadata writing utilities for Project Kestrel.

Writes XMP sidecar files (.xmp) embedding star ratings, culling labels,
and analysis metadata (species, family, quality score) alongside image
files. Compatible with Adobe Lightroom, darktable, and Capture One.
"""

import os
import sys

# XMP namespace URIs
_KESTREL_NS = 'http://ns.projectkestrel.app/xmp/1.0/'
_NS_RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'
_NS_XMP = 'http://ns.adobe.com/xap/1.0/'
_NS_DC = 'http://purl.org/dc/elements/1.1/'
_NS_LR = 'http://ns.adobe.com/lightroom/1.0/'

# Species/family values that indicate no meaningful detection
_EMPTY_LABELS = {'', 'unknown', 'no bird'}


def log(*args):
    """Log message to stderr with [metadata] prefix."""
    print('[metadata]', *args, file=sys.stderr)


def _xml_escape(text: str) -> str:
    """Escape special characters for XML attribute and text values."""
    return (
        text.replace('&', '&amp;')
        .replace('<', '&lt;')
        .replace('>', '&gt;')
        .replace('"', '&quot;')
        .replace("'", '&apos;')
    )


def _is_meaningful(value: str) -> bool:
    """Return True if a string label is a real detection (not blank/unknown)."""
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
    """Build a complete XMP packet string with rating, label, and Kestrel metadata."""
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

    # Kestrel-specific attributes
    lines.append(f'      kestrel:CullStatus="{_xml_escape(cull_status)}"')
    lines.append(f'      kestrel:SourceFile="{_xml_escape(filename)}"')
    if has_species:
        lines.append(f'      kestrel:Species="{_xml_escape(species)}"')
    if has_family:
        lines.append(f'      kestrel:Family="{_xml_escape(family)}"')
    if has_quality:
        lines.append(f'      kestrel:QualityScore="{quality_score:.4f}"')

    lines.append('    >')

    # dc:description — human-readable summary visible in Lightroom's metadata panel
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

    # dc:subject — hierarchical keywords for Lightroom keyword panel
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
    """Return True if the XMP file at ``path`` was written by Kestrel."""
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as f:
            content = f.read(4096)  # namespace declarations are near the top
        return _KESTREL_NS in content
    except Exception:
        return False


def write_xmp_metadata(root_path: str, image_data, overwrite_external: bool = False):
    """Write XMP sidecar files for each image, embedding star rating, culling
    label, and analysis metadata (species, family, quality score).

    Each entry in ``image_data`` is expected to be a dict with:
        filename  – bare filename (e.g. "IMG_0001.jpg")
        rating    – integer 0-5
        culled    – "accept" or "reject"
        species   – detected species name (optional)
        family    – detected family name (optional)
        quality   – raw quality score float 0.0–1.0 (optional)

    XMP sidecar files are written as ``<basename>.xmp`` alongside the
    original in ``root_path``.

    Safety rules:
      - If a ``.xmp`` file already exists and was written by Kestrel
        (detected by the presence of the Kestrel namespace URI), it is
        safe to overwrite and will always be updated.
      - If a ``.xmp`` file already exists but was written by external
        software (Lightroom, darktable, Capture One, etc.) AND
        ``overwrite_external`` is False, the file is skipped and its
        filename is added to ``skipped_conflicts`` in the response so the
        caller can ask the user for confirmation.
      - If ``overwrite_external`` is True, external XMP files are also
        overwritten.

    Returns:
        { success, written, skipped_conflicts: [filenames], errors }
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
                if cull_status == 'accept':
                    label = 'Green'
                elif cull_status == 'reject':
                    label = 'Red'
                else:
                    label = ''

                species = str(entry.get('species', '') or '').strip()
                family = str(entry.get('family', '') or '').strip()

                quality_raw = entry.get('quality', None)
                try:
                    quality_score = float(quality_raw) if quality_raw is not None else -1.0
                except (TypeError, ValueError):
                    quality_score = -1.0

                base, _ext = os.path.splitext(filename)
                xmp_filename = base + '.xmp'
                xmp_path = os.path.join(root_path, xmp_filename)

                # Safety check: if XMP already exists, verify origin
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

                with open(xmp_path, 'w', encoding='utf-8') as f:
                    f.write(xmp_content)

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
