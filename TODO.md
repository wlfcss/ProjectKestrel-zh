# Project Kestrel To-Do and Changelog

## Known Issues
- With the addition of multiple bird support, there is a slight increase in false bird detections. This needs to be investigated, and can likely be mitigated by raising the detection threshold.
- Bird species detection is often inaccurate.
- Lightroom support has not been tested on Windows
- Entire software has not been tested on MacOS.

## To-Do
- Build debug platform that runs Kestrel analysis, but saves the full output at every step for detailed troubleshooting and root-cause analysis.
    - e.g. save all masks, all bird species probabilities, all quality scores, etc. and visualize everything for easy detection.
    - This may be either a python notebook or a script, unsure.
- Implement a hierarchical bird species labelling system
    - e.g. collapse all potential sparrow species IDs into a "Sparrow sp." category, etc.
    - this way, an unconfident ID split between several sparrow species can be collapsed into one useful ID of "Sparrow sp."
    - this can also mitigate some questionable ID's of "Fish Crow" instead of "American Crow", etc.
- Implement improvements to Visualizer, such as modifying group species tags. 
- Fix issue with false bird detections to mitigate false positive results that skew identification in some complex scenes.
- Implement XMP-based metadata writing system, enabling Kestrel or the user to directly update image metadata in a way that is visible to Adobe Lightroom or Darktable
- Package software into an installer for ease of installation and use by users (this may require fetching version data from GitHub)

## Changelog

### Update 8/23/2025
- New web-based Kestrel Visualizer is now available. Matches all features of previous version, but uses a new web-based frontend that is remarkably faster. Introduces a few new features (merge scenes, user-defined ratings, lightroom support)
- Reworked analysis algorithms: Now has rudimentary support for non-bird wildlife (dogs, cats, bears, etc.) and will assign a quality score if detected.
- Reworked analysis algorithms: Now supports multiple birds present in the same photo for species analysis.
- New GUI-based Kestrel Analyzer is now available. Matches all features of Command-Line Interface, with the addition of pause/unpause analysis functionality. Displays the latest image detection as the software is running for cleaner user interface.
- Improvements to reduce memory consumption and bug fixes.
- Modified ReadME and relevant files to reflect the new changes and clarify confusing langauge.