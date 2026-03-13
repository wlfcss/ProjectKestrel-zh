# Project Kestrel To-Do and Changelog
* Investigate GPU support from recent pull request #14
* Improve version handling
* Investigate refinements to image quality thresholding from recent pull request #14. 
* Improve culling.html so that default behavior on unrated scenes is to reject with user-customizable option within the culling options. 

Bugs
* Photos don't automaticallyroll in over time.
* test whether that has been fixed. 
* May want to consider tightening mask probability threshold in mask-rcnn ?
* Some group detection failures in low-feature-point space. (ex. scene #30 high island 2024)
* The save changes feature isn't exactly working too well. I think we should just make it auto-save all changes and just maintain the revert changes button. 
* Split scene issue --> Doesn't exactly save automatically..
* Rating normalization --> I think we need to shift this a bit so that maybe the majority are 1-2 stars? And the minority are 3-5 stars? Or just turn off normalization by default? Not super sure here...
--> New quality algorithm should be trained on the new pipeline if possible, maybe combining a few orthogonal metrics.

    

Whats working
* Filtering out the duplicates seems to be working
* Burst detection seems to be working
* Seems like species accuracy is indeed improved a bit.
* Some issues with whether a particular folder appears as checkable or not






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
* Add "Clear Kestrel Analysis" button to a right-click menu. 
* Add un-group scene dialog box to the scene view.
* Add "Save changes before opening Culling Assistant" check and verify "Save changes before exiting" check
* Fix UI for scene editing view.
* Fixed UI for settings page and expanded number of potential editors to several new options with a dedicated "Custom application" page.
* Fix UI - Live Analysis Page
* Added "Accept All" and "Reject All" buttons in changelog

# Version Swamp Sparrow Changelog

* Refactor code to make it easier to edit.
* Investigate poor performance in poorly-lit circumstances, even if it is just to add an up to 1-2 stop exposure adjust.? - For this we need to finish Kestrel Workshop. 
* Improve star rating system - this sort of punishes people with different equipment by setting all their photos to "1 star" and thus making the system pretty bad. Add a normalization option in settings that essentially fits the ratings distribution folder-wide to a uniform distribution with 20% splits. this would make sure the star ratings cover the entire breadth of the folder and propbably improve culling performance too ? Default = within folder normalization
* test new exposure correction algorithm
* implemented database correction
* Consider making the auto-grouping threshold an adjustable analysis setting and storing timestamp metadata for future use in a timeline view. And consider changing scene naming (from #123) to reflect timestamp of the first img in the scene and then you can group it by hour? That'd be sick. Let's do that as a much more intuitive main interface. Will need a database upgrade though.
* Fix scene tags issue
* Setting to control false positivity rate.
* RAW preview within visualizer


Next version changelog:
* ETA calculation fails when resuming a folder that started to be analyzed.
* Massive issues with exposure correction --> Definitely needs to target a higher overall EV and needs to apply to all images for quality esitmation to work properly. Currently any dark photo gets heavily penalized once exposure correct shifts it down.
* Exposure normalization should be global across all images - remove the minimum shift cap. 
* Ratings are showing as 1 star by default for every single photo until a bit of database backlog happens. Fix this. 
* Exposure normalization step isn't really working right. Should target a histogram or make it histogram based (see kingbird photos, etc)
* RAW preview seems downscaled in culling assistant clearly - something is broken there.
* Some issues with underexposed birds being overcorrected too... Maybe just fix this exposure correction algorithm to just shift the extreme cases?
    Bad examples:
        005, 006 in high island 2024 should not be such high quality... ?