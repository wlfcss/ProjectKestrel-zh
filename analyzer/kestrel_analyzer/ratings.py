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


def compute_normalized_rating(quality: float, distribution: list) -> int:
    """Map a quality score to a star rating using a quality distribution.

    Star assignment is based on the percentile rank of the photo among all
    detected subjects, fitting the following target distribution:
      - Top 10%       -> 5 stars
      - 10 – 32.5%    -> 4 stars
      - 32.5 – 55%    -> 3 stars
      - 55 – 77.5%    -> 2 stars
      - Bottom 22.5%  -> 1 star
      - quality < 0   -> 0 stars (no detection / unprocessed)

    Falls back to quality_to_rating() if the distribution is empty.
    """
    if quality < 0:
        return 0
    total = sum(distribution)
    if total == 0:
        return quality_to_rating(quality)
    bucket = min(int(quality * 100), 99)
    below = sum(distribution[:bucket])
    within = distribution[bucket]
    # fraction_rank: 0.0 = worst quality, 1.0 = best quality
    fraction_rank = (below + within * 0.5) / total
    if fraction_rank >= 0.90:
        return 5
    if fraction_rank >= 0.675:
        return 4
    if fraction_rank >= 0.45:
        return 3
    if fraction_rank >= 0.225:
        return 2
    return 1


def get_image_display_rating(
    filename: str,
    quality: float,
    user_image_ratings: dict,
    distribution: list,
) -> tuple:
    """Return (rating, origin) for display, preferring user-specified over auto-computed.

    Args:
        filename: Image filename (key into user_image_ratings).
        quality: Raw quality score from analysis pipeline.
        user_image_ratings: Dict mapping filename -> int (from kestrel_scenedata.json).
        distribution: Quality distribution list (100 buckets) for normalization.

    Returns:
        (rating: int 0-5, origin: str 'manual' | 'auto')
    """
    if filename in user_image_ratings:
        r = user_image_ratings[filename]
        try:
            return max(0, min(5, int(r))), "manual"
        except (TypeError, ValueError):
            pass
    return compute_normalized_rating(quality, distribution), "auto"
