# Input Methods

Agent Workbench supports multiple input methods for providing information to a task session.

## Text Input

- The input box supports multi-line text; press `Shift + Enter` to insert a newline
- Press `Enter` to send the message
- Markdown formatting is rendered

## File Attachments

- Click the paperclip icon on the left side of the input box to upload files
- Multiple files can be uploaded at once
- File contents are read and included as part of the context sent to the model
- Supported file types depend on the browser and system environment

## Voice Input

- Click the microphone icon to enable speech recognition
- Uses the browser's Web Speech API; no additional installation required
- Recognition results fill the input box and can be edited before sending
- Compatibility depends on whether the browser supports the SpeechRecognition interface
