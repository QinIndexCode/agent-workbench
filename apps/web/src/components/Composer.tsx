import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowUp, ChevronDown, Eye, Folder, LoaderCircle, MessageCircle, Mic, MicOff, Paperclip, ShieldAlert, SlidersHorizontal, Square } from "lucide-react";
import type { TaskAttachment } from "@scc/shared";
import { getUiCopy } from "../i18n.js";
import { FileTypeIcon } from "./FileTypeIcon.js";

function VoiceWaveform() {
  return (
    <span className="voiceWaveform" aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}

export type ComposerMode = "new_task" | "guidance" | "continue";
export type PermissionPreset = "ask" | "read_only" | "all";
export type ComposerPermissionMode = PermissionPreset | "custom";

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

export function Composer({
  busy,
  attachments = [],
  attachmentBusy = false,
  attachmentError,
  draft,
  language,
  folderOptions = [],
  folderValue,
  modelLabel,
  modelOptions = [],
  modelValue,
  permissionPreset = "ask",
  permissionScopeLabel,
  running,
  mode,
  onDraftChange,
  onFilesSelected,
  onRemoveAttachment,
  onFolderChange,
  onModelChange,
  onOpenPermissionSettings,
  onOpenCustomPermissions,
  onRestoreCustomPermissions,
  hasCustomSnapshot = false,
  onPermissionPresetChange,
  onSubmit,
  onStop
}: {
  busy: boolean;
  attachments?: TaskAttachment[];
  attachmentBusy?: boolean;
  attachmentError?: string | null;
  draft?: string;
  language?: string | null;
  folderOptions?: Array<{ description?: string; label: string; value: string }> | undefined;
  folderValue?: string | undefined;
  modelLabel?: string;
  modelOptions?: Array<{ icon?: ReactNode; label: string; value: string }>;
  modelValue?: string;
  permissionPreset?: ComposerPermissionMode;
  permissionScopeLabel?: string;
  running: boolean;
  mode: ComposerMode;
  onDraftChange?: (text: string) => void;
  onFilesSelected?: (files: File[]) => Promise<void> | void;
  onRemoveAttachment?: (attachmentId: string) => Promise<void> | void;
  onFolderChange?: ((folderId: string) => void) | undefined;
  onModelChange?: (modelId: string) => void;
  onOpenPermissionSettings?: () => void;
  onOpenCustomPermissions?: () => void;
  onRestoreCustomPermissions?: () => void;
  hasCustomSnapshot?: boolean;
  onPermissionPresetChange?: (preset: PermissionPreset) => void;
  onSubmit: (text: string) => void;
  onStop: () => void;
}) {
  const [localText, setLocalText] = useState("");
  const [listening, setListening] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const text = draft ?? localText;
  const canSubmit = text.trim().length > 0;
  const canStop = running && !canSubmit;
  const labels = getUiCopy(language).composer;
  const modeCopy = labels.modes[mode];
  const permissionOptions = getPermissionOptions(labels);
  const currentPermission = permissionOptions.find((option) => option.value === permissionPreset) ?? permissionOptions[0]!;
  const currentFolder = folderOptions.find((option) => option.value === folderValue) ?? folderOptions[0];
  const currentModel = modelOptions.find((option) => option.value === modelValue) ?? modelOptions[0];
  const icon = busy ? (
    <LoaderCircle className="spin" size={18} />
  ) : canStop ? (
    <Square size={14} />
  ) : (
    <ArrowUp size={18} />
  );
  const label = busy ? labels.working : canSubmit ? labels.send : canStop ? labels.stop : labels.idle;

  return (
    <form
      className={mode === "new_task" ? "composer composerLarge" : "composer"}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="composerInputWrap">
        <div className="voiceListeningBar" data-listening={listening}>
          <VoiceWaveform />
        </div>
        <textarea
          ref={textareaRef}
          aria-label="Task input"
          placeholder={modeCopy[0]}
          rows={4}
          value={text}
          onChange={(event) => {
            updateText(event.target.value);
            resize(event.currentTarget);
          }}
          onKeyDown={handleKeyDown}
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          tabIndex={-1}
          aria-hidden="true"
          className="visuallyHidden"
          onChange={(event) => void attachFiles(event.currentTarget.files)}
        />
        {attachments.length > 0 || attachmentBusy || attachmentError ? (
          <div className="attachmentTray" aria-label={labels.attachments}>
            {attachments.map((attachment) => (
              <span className="attachmentChip" key={attachment.id} title={`${attachment.fileName} · ${formatFileSize(attachment.size)}`}>
                <FileTypeIcon fileName={attachment.fileName} kind={attachment.kind} />
                <span>
                  <strong>{attachment.fileName}</strong>
                  <small>{formatFileSize(attachment.size)}</small>
                </span>
                <button type="button" aria-label={labels.removeAttachment(attachment.fileName)} onClick={() => void onRemoveAttachment?.(attachment.id)}>
                  ×
                </button>
              </span>
            ))}
            {attachmentBusy ? <span className="attachmentChip uploading"><LoaderCircle className="spin" size={14} /> {labels.uploading}</span> : null}
            {attachmentError ? <span className="attachmentError">{attachmentError}</span> : null}
          </div>
        ) : null}
      </div>
      <div className="composerFooter">
        <div className="composerToolbar" aria-label="Input actions">
          <button className="composerToolButton" aria-label={labels.attachFile} disabled={busy || attachmentBusy} type="button" onClick={() => fileInputRef.current?.click()}>
            <Paperclip size={17} />
          </button>
          <button
            className={listening ? "composerToolButton voiceActive" : "composerToolButton"}
            aria-label={listening ? labels.voiceInputStop : labels.voiceInput}
            disabled={busy || !speechRecognitionSupported()}
            title={speechRecognitionSupported() ? labels.voiceInput : labels.voiceUnsupported}
            type="button"
            onClick={toggleVoiceInput}
          >
            {listening ? <MicOff size={17} /> : <Mic size={17} />}
          </button>
          <span className="composerDivider" aria-hidden="true" />
          {folderOptions.length > 0 && currentFolder ? (
            <div className={folderOpen ? "composerModelAccordion composerFolderAccordion open" : "composerModelAccordion composerFolderAccordion"} title={`${labels.folder}: ${currentFolder.description ?? currentFolder.label}`}>
              <button
                aria-expanded={folderOpen}
                aria-label={labels.folderToggle}
                className="modelAccordionTrigger folderAccordionTrigger"
                disabled={busy}
                type="button"
                onClick={() => {
                  setFolderOpen((open) => !open);
                  setModelOpen(false);
                  setPermissionOpen(false);
                }}
              >
                <Folder size={13} aria-hidden="true" />
                <span className="modelTriggerText">
                  <strong>{currentFolder.label}</strong>
                </span>
                <ChevronDown className="accordionChevron" size={13} />
              </button>
              <div className="modelAccordionPanel folderAccordionPanel" aria-label={labels.folder} aria-hidden={!folderOpen}>
                {folderOptions.map((option) => (
                  <button
                    key={option.value}
                    aria-pressed={(folderValue || currentFolder.value) === option.value}
                    className={(folderValue || currentFolder.value) === option.value ? "modelOption folderOption selected" : "modelOption folderOption"}
                    disabled={busy}
                    tabIndex={folderOpen ? 0 : -1}
                    title={option.description ?? option.label}
                    type="button"
                    onClick={() => {
                      onFolderChange?.(option.value);
                      setFolderOpen(false);
                    }}
                  >
                    <span>{option.label}</span>
                    {option.description ? <small>{option.description}</small> : null}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {modelOptions.length > 0 && currentModel ? (
            <div className={modelOpen ? "composerModelAccordion open" : "composerModelAccordion"} title={`${labels.model}: ${currentModel.label}`}>
              <button
                aria-expanded={modelOpen}
                aria-label={labels.modelToggle}
                className="modelAccordionTrigger"
                disabled={busy}
                type="button"
                onClick={() => {
                  setModelOpen((open) => !open);
                  setFolderOpen(false);
                  setPermissionOpen(false);
                }}
              >
                {currentModel.icon ? <span className="modelTriggerIcon" aria-hidden="true">{currentModel.icon}</span> : <span className="modelDot" aria-hidden="true" />}
                <span className="modelTriggerText">
                  <strong>{currentModel.label}</strong>
                </span>
                <ChevronDown className="accordionChevron" size={13} />
              </button>
              <div className="modelAccordionPanel" aria-label={labels.model} aria-hidden={!modelOpen}>
                {modelOptions.map((option) => (
                  <button
                    key={option.value}
                    aria-pressed={(modelValue || currentModel.value) === option.value}
                    className={(modelValue || currentModel.value) === option.value ? "modelOption selected" : "modelOption"}
                    disabled={busy}
                    tabIndex={modelOpen ? 0 : -1}
                    type="button"
                    onClick={() => {
                      onModelChange?.(option.value);
                      setModelOpen(false);
                    }}
                  >
                    {option.icon ? <span className="modelOptionIcon" aria-hidden="true">{option.icon}</span> : null}
                    <span>{option.label}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <span className="composerChip">{labels.model}: {modelLabel ?? labels.modelUnknown}</span>
          )}
          <div className={permissionOpen ? "composerPermissionAccordion open" : "composerPermissionAccordion"} title={permissionScopeLabel ?? currentPermission.description}>
            <button
              aria-expanded={permissionOpen}
              aria-label={labels.permissionToggle}
              className="permissionAccordionTrigger"
              disabled={busy}
              type="button"
              onClick={() => {
                setPermissionOpen((open) => !open);
                setFolderOpen(false);
                setModelOpen(false);
              }}
            >
              {currentPermission.icon}
              <span>{currentPermission.label}</span>
              <ChevronDown className="permissionChevron" size={13} />
            </button>
            <div className="permissionAccordionPanel" aria-label={labels.permission} aria-hidden={!permissionOpen}>
              {permissionOptions.map((option) => (
                <PermissionPresetButton
                  key={option.value}
                  currentPreset={permissionPreset}
                  hasCustomSnapshot={hasCustomSnapshot}
                  disabled={busy}
                  description={option.description}
                  icon={option.icon}
                  label={option.label}
                  selected={permissionPreset === option.value}
                  tabIndex={permissionOpen ? 0 : -1}
                  value={option.value}
                  onOpenCustom={() => {
                    onOpenCustomPermissions?.();
                    setPermissionOpen(false);
                  }}
                  onRestoreCustom={() => {
                    onRestoreCustomPermissions?.();
                    setPermissionOpen(false);
                  }}
                  onSelect={(preset) => {
                    onPermissionPresetChange?.(preset);
                    setPermissionOpen(false);
                  }}
                />
              ))}
            </div>
          </div>
        </div>
        <button className="composerPrimaryButton" aria-label={label} disabled={busy || (!canSubmit && !running)} type="submit">
          {icon}
        </button>
      </div>
    </form>
  );

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  }

  function submit() {
    if (busy) return;
    if (canSubmit) {
      onSubmit(text.trim());
      updateText("");
      if (textareaRef.current) resize(textareaRef.current, true);
    } else if (running) {
      onStop();
    }
  }

  async function attachFiles(files: FileList | null) {
    if (!files?.length) return;
    await onFilesSelected?.([...files]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function appendText(value: string) {
    const next = text.trimEnd().length > 0 ? `${text.trimEnd()}\n\n${value}` : value;
    updateText(next);
    window.setTimeout(() => {
      if (textareaRef.current) resize(textareaRef.current);
    }, 0);
  }

  function toggleVoiceInput() {
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }
    const Recognition = getSpeechRecognitionCtor();
    if (!Recognition) return;
    const recognition = new Recognition();
    recognition.lang = language || "zh-CN";
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      const transcript = [...Array.from(event.results)]
        .filter((result) => result.isFinal)
        .map((result) => result[0].transcript.trim())
        .filter(Boolean)
        .join(" ");
      if (transcript) appendText(transcript);
    };
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    setListening(true);
    recognition.start();
  }

  function updateText(next: string) {
    if (draft !== undefined) {
      onDraftChange?.(next);
      return;
    }
    setLocalText(next);
  }
}

function PermissionPresetButton({
  currentPreset,
  hasCustomSnapshot,
  description,
  disabled,
  icon,
  label,
  selected,
  tabIndex,
  value,
  onOpenCustom,
  onRestoreCustom,
  onSelect
}: {
  currentPreset: ComposerPermissionMode;
  hasCustomSnapshot: boolean;
  description: string;
  disabled: boolean;
  icon: ReactNode;
  label: string;
  selected: boolean;
  tabIndex: number;
  value: ComposerPermissionMode;
  onOpenCustom: (() => void) | undefined;
  onRestoreCustom: (() => void) | undefined;
  onSelect: ((preset: PermissionPreset) => void) | undefined;
}) {
  return (
    <button
      aria-pressed={selected}
      className={selected ? "permissionPresetButton selected" : "permissionPresetButton"}
      disabled={disabled}
      tabIndex={tabIndex}
      title={description}
      onClick={() => {
        if (value === "custom") {
          if (currentPreset === "custom") {
            return;
          }
          if (hasCustomSnapshot) {
            onRestoreCustom?.();
          } else {
            onOpenCustom?.();
          }
          return;
        }
        onSelect?.(value);
      }}
      type="button"
    >
      {icon}
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
    </button>
  );
}

function getPermissionOptions(labels: ReturnType<typeof getUiCopy>["composer"]): Array<{
  description: string;
  icon: ReactNode;
  label: string;
  value: ComposerPermissionMode;
}> {
  return [
    {
      description: labels.permissionPresetDescriptions.ask,
      icon: <MessageCircle size={14} />,
      label: labels.permissionPresets.ask,
      value: "ask"
    },
    {
      description: labels.permissionPresetDescriptions.read_only,
      icon: <Eye size={14} />,
      label: labels.permissionPresets.read_only,
      value: "read_only"
    },
    {
      description: labels.permissionPresetDescriptions.custom,
      icon: <SlidersHorizontal size={14} />,
      label: labels.permissionPresets.custom,
      value: "custom"
    },
    {
      description: labels.permissionPresetDescriptions.all,
      icon: <ShieldAlert size={14} />,
      label: labels.permissionPresets.all,
      value: "all"
    }
  ];
}

function resize(element: HTMLTextAreaElement, reset = false) {
  element.style.height = "auto";
  element.style.height = reset ? "" : `${Math.min(element.scrollHeight, 260)}px`;
}

function speechRecognitionSupported(): boolean {
  return Boolean(getSpeechRecognitionCtor());
}

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  const win = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
