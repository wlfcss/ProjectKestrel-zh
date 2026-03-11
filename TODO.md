# Project Kestrel To-Do and Changelog

* Fix UI - Live Analysis Page
* Investigate refinements to image quality thresholding from recent pull request #14. 
* Investigate GPU support from recent pull request #14


* Add "Clear Kestrel Analysis" button to a right-click menu. 
* Add un-group scene dialog box to the scene view.
* Add "Save changes before opening Culling Assistant" check and verify "Save changes before exiting" check


# Priority Issues
* Slightly longer load time in latest version of Kestrel, potentially due to added imports or longer files. 
- Add "Threshold"/basic customization support (star ratings or Q score) to culling assistant

## Known Issues
- Kestrel's data structure (csv database) is a bit messay and incomplete. Potentially need to switch to a JSON file structure while maintaining backward-compatibility or upgradeability in the visualizer.

## Features under consideration
- Build debug platform that runs Kestrel analysis, but saves the full output at every step for detailed troubleshooting and root-cause analysis. (Under Consideration, likely requires simple modification of CLI)
    - e.g. save all masks, all bird species probabilities, all quality scores, etc. and visualize everything for easy detection.
    - This may be either a python notebook or a script, unsure.
- Implement improvements to Visualizer, such as modifying group species tags. (Under Consideration)
- Improve quality estimation model to be more robust (Shelved)

# Version Yellow Warbler Changelog
* Massive improvement to Kestrel group detection methodology particularly for birds in flight
* Removed tendency to identify other non-bird animals and placed behind a dedicated checkbox
* Hidden "Use GPU When Available" if app is frozen due to lack of implementation in current system
* Add check for analysis version, prompt user whether they want to re-analyze an already analyzed folder that is on a lower version. I.e. italicize if version is lower.