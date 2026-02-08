# Project Kestrel To-Do and Changelog

# Priority Issues
* Issue with multi-subject mode detecting false birds and ranking those subjects with higher quality over the true bird. This may be confusing and unoptimal behavior. Potentially add a multi-subject-mode toggle or allow the user to scroll between multiple bird thumbnails/store all (up to 5) subject thumbnails.
    - Potential improvement: Exclude lower-confidence detections that overlap with higher-confidence detections
    - Potential improvement: raise detection threshold to avoid falsely flagging leaves
    - Potential improvement: Focus on highest-confidence detection for quality estimation, rather than highest-quality image.
    
* Error handling may not be functioning correctly - ex. when mask-rcnn detects too many subjects and returns a memory error, it may not be getting logged properly.


## Known Issues
- Kestrel's analysis struggles heavily with back-lit/front-dim images. The quality estimation and species detection suffers significantly because of this. An exposure normalization step should be cosnidered to standardize the exposure of the bird pixels.
- Lightroom support has not been tested on Windows
- Entire software has not been tested on MacOS.
- Kestrel's data structure (csv database) is a bit messay and incomplete. Potentially need to switch to a JSON file structure while maintaining backward-compatibility in the visualizer.
- There may be a performance issue associated with specific package versions. This is under investigation.


## Features under consideration
- Build debug platform that runs Kestrel analysis, but saves the full output at every step for detailed troubleshooting and root-cause analysis. (Under Consideration, likely requires simple modification of CLI)
    - e.g. save all masks, all bird species probabilities, all quality scores, etc. and visualize everything for easy detection.
    - This may be either a python notebook or a script, unsure.
- Implement improvements to Visualizer, such as modifying group species tags. (Under Consideration)
- Improve quality estimation model to be more robust (Shelved)
- Implement XMP-based metadata writing system, enabling Kestrel or the user to directly update image metadata in a way that is visible to Adobe Lightroom or Darktable (Awaiting user feedback to determine priority)
- Create a system to queue multiple folders for analysis (CLI exists, but awaiting user feedback to determine priority)