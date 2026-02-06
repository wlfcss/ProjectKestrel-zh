# Project Kestrel To-Do and Changelog

# Latest Issues
* Bug in visualizer when run via .exe; does not open preferred editor by default (and no method to permanently store preferred editor config.) (might also exist when running in native python!). Need to open the settings and close it and then it starts working.
    * This is simply because there isn't a current persistent method to create a kestrel configuration file. Unclear how to fix this.
* Issue in visualizer where it won't find the kestrel database if you open the .kestrel folder. This can be mitigated by searching multiple levels.
* Issue in visualizer where user interface is not intuitive? ex. "Open kestrel_database.csv" is unusual; 


## Known Issues
- Kestrel's analysis struggles heavily with back-lit/front-dim images. The quality estimation and species detection suffers significantly because of this. An exposure normalization step should be cosnidered to standardize the exposure of the bird pixels.
- Lightroom support has not been tested on Windows
- Entire software has not been tested on MacOS.
- Kestrel's data structure (csv database) is a bit messay and incomplete. Potentially need to switch to a JSON file structure while maintaining backward-compatibility in the visualizer.
- There may be a performance issue associated with specific package versions. This is under investigation.

Fixed issues:
- With the addition of multiple bird support, there is a slight increase in false bird detections. This needs to be investigated, and can likely be mitigated by raising the detection threshold. (DONE)
- Bird species detection is often inaccurate. (DONE - implemented family classifier system)

## To-Do
- Build debug platform that runs Kestrel analysis, but saves the full output at every step for detailed troubleshooting and root-cause analysis.
    - e.g. save all masks, all bird species probabilities, all quality scores, etc. and visualize everything for easy detection.
    - This may be either a python notebook or a script, unsure.
- Implement improvements to Visualizer, such as modifying group species tags. 
- Implement XMP-based metadata writing system, enabling Kestrel or the user to directly update image metadata in a way that is visible to Adobe Lightroom or Darktable
- Package software into an installer for ease of installation and use by users (this may require fetching version data from GitHub)
- Merge hierarchical species labeling system into the CLI.
- Create a system to queue multiple folders for analysis

Completed tasks:
- Implement a hierarchical bird species labelling system - DONE
    - e.g. collapse all potential sparrow species IDs into a "Sparrow sp." category, etc.
    - this way, an unconfident ID split between several sparrow species can be collapsed into one useful ID of "Sparrow sp."
    - this can also mitigate some questionable ID's of "Fish Crow" instead of "American Crow", etc.
- Fix issue with false bird detections to mitigate false positive results that skew identification in some complex scenes. (DONE - raised threshold to 0.7)

## Changelog

### Update 9/13/2025
- Species classifier has a major update. There is now a "Family" classification system. 
    - Kestrel's confidence in bird species classification is sometimes split across a few related species (i.e. 30% Song Sparrow, 20% Fox Sparrow, 15% Clay-Colored Sparrow)
    - Now, Kestrel aggregates its species predictions by family (i.e. 65% Sparrow sp.)
    - This enables the user to search by species with greater flexibility
- Kestrel's visualizer has been updated with this change.
- Small update to the analyzer script to fix a bug where the previous image was not loaded properly when resuming analysis, creating false scene splits
- Update to analyzer script to include the analysis version

### Update 8/23/2025
- New web-based Kestrel Visualizer is now available. Matches all features of previous version, but uses a new web-based frontend that is remarkably faster. Introduces a few new features (merge scenes, user-defined ratings, lightroom support)
- Reworked analysis algorithms: Now has rudimentary support for non-bird wildlife (dogs, cats, bears, etc.) and will assign a quality score if detected.
- Reworked analysis algorithms: Now supports multiple birds present in the same photo for species analysis.
- New GUI-based Kestrel Analyzer is now available. Matches all features of Command-Line Interface, with the addition of pause/unpause analysis functionality. Displays the latest image detection as the software is running for cleaner user interface.
- Improvements to reduce memory consumption and bug fixes.
- Modified ReadME and relevant files to reflect the new changes and clarify confusing langauge.