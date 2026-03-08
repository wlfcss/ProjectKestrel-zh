#!/usr/bin/env python3
"""XMP metadata writing utilities for Project Kestrel.

Provides functions to write XMP sidecar files embedding star ratings
and culling labels alongside image files.
"""

import os
import sys


def log(*args):
    """Log message to stderr with [metadata] prefix."""
    print('[metadata]', *args, file=sys.stderr)


def write_xmp_metadata(root_path: str, image_data, overwrite_external: bool = False):
    """Write XMP sidecar files for each image, embedding star rating and culling label.

    Each entry in ``image_data`` is expected to be a dict with:
        filename  – bare filename (e.g. "IMG_0001.jpg")
        rating    – integer 0-5
        culled    – "accept" or "reject"

    XMP sidecar files are written as ``<basename>.xmp`` alongside the
    original in ``root_path``.

    Safety rules:
      - If a ``.xmp`` file already exists and was written by Kestrel
        (detected by the presence of the ``kestrel:`` namespace URI), it is
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

    TODO: Finalise the XMP schema / sidecar format once the research phase
    is complete.  The current template is minimal but valid.
    """
    _KESTREL_NS = 'http://ns.projectkestrel.app/xmp/1.0/'

    def _is_kestrel_xmp(path: str) -> bool:
        """Return True if the file appears to have been written by Kestrel."""
        try:
            with open(path, 'r', encoding='utf-8', errors='replace') as f:
                content = f.read(4096)  # Only need the header/namespace section
            return _KESTREL_NS in content
        except Exception:
            return False

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

                cull_status = str(entry.get('culled', 'accept')).lower()
                adobe_label = 'Green' if cull_status == 'accept' else 'Red'

                # Derive sidecar path: same directory, extension replaced with .xmp
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

                # Minimal XMP sidecar template
                # TODO: extend with full dc:, exif:, and Lightroom lr: namespaces
                #       once the exact schema is confirmed.
                xmp_content = (
                    '<?xpacket begin="\xef\xbb\xbf" id="W5M0MpCehiHzreSzNTczkc9d"?>\n'
                    '<x:xmpmeta xmlns:x="adobe:ns:meta/">\n'
                    '  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n'
                    '    <rdf:Description rdf:about=""\n'
                    '        xmlns:xmp="http://ns.adobe.com/xap/1.0/"\n'
                    '        xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"\n'
                    f'        xmlns:kestrel="{_KESTREL_NS}">\n'
                    f'      <xmp:Rating>{rating}</xmp:Rating>\n'
                    f'      <xmp:Label>{adobe_label}</xmp:Label>\n'
                    f'      <kestrel:CullStatus>{cull_status}</kestrel:CullStatus>\n'
                    f'      <kestrel:SourceFile>{filename}</kestrel:SourceFile>\n'
                    '    </rdf:Description>\n'
                    '  </rdf:RDF>\n'
                    '</x:xmpmeta>\n'
                    '<?xpacket end="w"?>\n'
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
