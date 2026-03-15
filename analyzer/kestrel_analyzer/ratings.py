def quality_to_rating(q: float) -> int:
    if q == -1:
        return 0
    if q < 0.15:
        return 1
    if q < 0.3:
        return 2
    if q < 0.6:
        return 3
    if q < 0.9:
        return 4
    return 5


def compute_quality_distribution(quality_scores) -> list:
    """Compute distribution of quality scores in 100 buckets of 0.01 width.

    Only includes scores >= 0 (detected subjects; quality == -1 means no detection).
    Returns a list of 100 ints where index i = count of scores in [i*0.01, (i+1)*0.01).
    """
    buckets = [0] * 100
    for q in quality_scores:
        try:
            q_f = float(q)
        except (TypeError, ValueError):
            continue
        if q_f >= 0:
            idx = min(int(q_f * 100), 99)
            buckets[idx] += 1
    return buckets


def compute_normalized_rating(
    quality: float,
    distribution: list,
    thresholds: dict = None,
) -> int:
    """Map a quality score to a star rating using a quality distribution.

    Star assignment is based on the percentile rank of the photo among all
    detected subjects, using customizable thresholds.

    Args:
        quality: Raw quality score (0.0 to 1.0, or -1 for no detection).
        distribution: Quality distribution list (100 buckets) for normalization.
        thresholds: Optional dict with keys 'five', 'four', 'three', 'two' (fractional
                   percentiles). Defaults to standard thresholds if not provided.

    Returns:
        Star rating 0-5 (0 = no detection / unprocessed).

    Example thresholds (as percentiles 0.0-1.0):
        {'five': 0.88, 'four': 0.73, 'three': 0.53, 'two': 0.23}
    """
    if quality < 0:
        return 0
    
    # Default thresholds: 12%, 15%, 20%, 30%, 23%
    if thresholds is None:
        thresholds = {
            'five': 0.88,   # top 12%
            'four': 0.73,   # 12-27%
            'three': 0.53,  # 27-47%
            'two': 0.23,    # 47-77%
        }
    
    total = sum(distribution)
    if total == 0:
        return quality_to_rating(quality)
    bucket = min(int(quality * 100), 99)
    below = sum(distribution[:bucket])
    within = distribution[bucket]
    # fraction_rank: 0.0 = worst quality, 1.0 = best quality
    fraction_rank = (below + within * 0.5) / total
    if fraction_rank >= thresholds.get('five', 0.88):
        return 5
    if fraction_rank >= thresholds.get('four', 0.73):
        return 4
    if fraction_rank >= thresholds.get('three', 0.53):
        return 3
    if fraction_rank >= thresholds.get('two', 0.23):
        return 2
    return 1


def get_image_display_rating(
    filename: str,
    quality: float,
    user_image_ratings: dict,
    distribution: list,
    thresholds: dict = None,
) -> tuple:
    """Return (rating, origin) for display, preferring user-specified over auto-computed.

    Args:
        filename: Image filename (key into user_image_ratings).
        quality: Raw quality score from analysis pipeline.
        user_image_ratings: Dict mapping filename -> int (from kestrel_scenedata.json).
        distribution: Quality distribution list (100 buckets) for normalization.
        thresholds: Optional dict with percentile thresholds (see compute_normalized_rating).

    Returns:
        (rating: int 0-5, origin: str 'manual' | 'auto')
    """
    if filename in user_image_ratings:
        r = user_image_ratings[filename]
        try:
            return max(0, min(5, int(r))), "manual"
        except (TypeError, ValueError):
            pass
    return compute_normalized_rating(quality, distribution, thresholds), "auto"
