import './style.css'

type SupportedMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
type MessageRole = 'assistant' | 'user' | 'error'

interface InstructionResponse {
  endpoint: string
  method: SupportedMethod
  params: Record<string, unknown>
}

interface TranscribeFlowResponse {
  transcription: string
  instruction: InstructionResponse
  result: unknown
}

interface ChatMessage {
  id: number
  role: MessageRole
  heading: string
  body: string
  instruction?: InstructionResponse | null
  response?: unknown
  timestamp: string
}

interface AppState {
  transcription: string
  microphoneState: string
  isRecording: boolean
  isLoading: boolean
  supportsAudioCapture: boolean
  transcriptionFailures: number
  manualFallbackEnabled: boolean
  chat: ChatMessage[]
}

const API_BASE_URL = normalizeBaseUrl(import.meta.env.VITE_API_BASE_URL ?? '')
const STORAGE_KEY_TRANSCRIBE_LANG = 'voice-command-api.transcribe-language'
const REQUEST_TIMEOUT_MS = 45000
const MAX_RECORDING_MS = 20000
const MAX_AUTO_FAILURES = 2
/** Emit audio chunks periodically so the final WebM contains real speech, not mostly silence (reduces Whisper “hallucinations” like Gracias). */
const RECORDING_TIMESLICE_MS = 250

const supportsAudioCapture =
  Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== 'undefined'

const state: AppState = {
  transcription: '',
  microphoneState: supportsAudioCapture
    ? 'Press record. Audio stops automatically after 20 seconds.'
    : 'Audio recording is unavailable in this browser.',
  isRecording: false,
  isLoading: false,
  supportsAudioCapture,
  transcriptionFailures: 0,
  manualFallbackEnabled: !supportsAudioCapture,
  chat: [
    {
      id: Date.now(),
      role: 'assistant',
      heading: 'Voice Task Assistant',
      body: 'Record a command on the right. I will show the transcription the backend heard and the final task API response here.',
      timestamp: formatTime(),
    },
  ],
}

const app = document.querySelector<HTMLDivElement>('#app')

if (!app) {
  throw new Error('App root not found')
}

app.innerHTML = `
  <main class="app-shell">
    <section class="workspace">
      <section class="chat-column panel">
        <header class="section-header">
          <div>
            <span class="section-kicker">Conversation</span>
            <h1>API chat transcript</h1>
          </div>
          <p>The assistant logs the transcription returned by the backend and the final task response for each command.</p>
        </header>
        <div id="chat-thread" class="chat-thread"></div>
      </section>

      <aside class="voice-column panel">
        <header class="section-header compact">
          <div>
            <span class="section-kicker">Recorder</span>
            <h2>20 second voice capture</h2>
          </div>
          <p class="status-copy" id="microphone-state"></p>
        </header>

        <div class="listen-stage">
          <div class="pulse-ring" id="pulse-ring">
            <div class="pulse-core"></div>
          </div>
          <div class="listen-copy">
            <span class="section-kicker">Live status</span>
            <h3 id="listening-chip"></h3>
            <p>
              After two failed recordings, manual transcription unlocks automatically. Speak for several seconds; if the clip
              is mostly silence, Whisper often guesses short words like “Gracias”.
            </p>
          </div>
        </div>

        <label class="field-label" for="transcribe-lang">Transcription language (Whisper)</label>
        <select id="transcribe-lang" class="transcribe-lang-select" aria-label="Transcription language">
          <option value="">Auto-detect</option>
          <option value="es">Español</option>
          <option value="en">English</option>
          <option value="fr">Français</option>
          <option value="pt">Português</option>
          <option value="de">Deutsch</option>
          <option value="it">Italiano</option>
        </select>

        <div class="actions-row">
          <button id="listen-toggle" class="primary-button" type="button"></button>
        </div>

        <section id="manual-fallback" class="manual-panel" hidden>
          <label class="field-label" for="transcription-input">Manual transcription</label>
          <textarea
            id="transcription-input"
            name="transcription-input"
            rows="5"
            placeholder="Type a command such as: add buy groceries to my list"
          ></textarea>
          <button id="run-manual" class="secondary-button" type="button">Send manual transcription</button>
        </section>
      </aside>
    </section>
  </main>
`

const listenToggleButton = mustQuery<HTMLButtonElement>('#listen-toggle')
const transcribeLangSelect = mustQuery<HTMLSelectElement>('#transcribe-lang')
const manualFallbackPanel = mustQuery<HTMLElement>('#manual-fallback')
const runManualButton = mustQuery<HTMLButtonElement>('#run-manual')
const transcriptionInput = mustQuery<HTMLTextAreaElement>('#transcription-input')
const microphoneState = mustQuery<HTMLParagraphElement>('#microphone-state')
const listeningChip = mustQuery<HTMLHeadingElement>('#listening-chip')
const pulseRing = mustQuery<HTMLDivElement>('#pulse-ring')
const chatThread = mustQuery<HTMLDivElement>('#chat-thread')

let mediaRecorder: MediaRecorder | null = null
let recordedChunks: BlobPart[] = []
let activeStream: MediaStream | null = null
let stopTimerId: number | null = null

function pickRecorderMimeType(): string | undefined {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ]
  for (const mimeType of candidates) {
    if (MediaRecorder.isTypeSupported(mimeType)) {
      return mimeType
    }
  }
  return undefined
}

transcribeLangSelect.value = localStorage.getItem(STORAGE_KEY_TRANSCRIBE_LANG) ?? ''
transcribeLangSelect.addEventListener('change', () => {
  const v = transcribeLangSelect.value
  if (v) {
    localStorage.setItem(STORAGE_KEY_TRANSCRIBE_LANG, v)
  } else {
    localStorage.removeItem(STORAGE_KEY_TRANSCRIBE_LANG)
  }
})

listenToggleButton.addEventListener('click', async () => {
  if (!state.supportsAudioCapture) {
    registerFailure('Audio capture is not available in this browser. Manual transcription is now enabled.')
    return
  }

  if (state.isRecording) {
    stopRecording('Stopping recording...')
    return
  }

  state.transcription = ''
  render()
  await startRecording()
})

runManualButton.addEventListener('click', async () => {
  await submitManualTranscription(transcriptionInput.value)
})

transcriptionInput.addEventListener('input', () => {
  state.transcription = transcriptionInput.value
})

render()

async function startRecording(): Promise<void> {
  try {
    recordedChunks = []
    activeStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const mimeType = pickRecorderMimeType()
    mediaRecorder = mimeType
      ? new MediaRecorder(activeStream, { mimeType })
      : new MediaRecorder(activeStream)

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        recordedChunks.push(event.data)
      }
    }

    mediaRecorder.onerror = () => {
      registerFailure('The browser failed while recording audio.')
    }

    mediaRecorder.onstart = () => {
      state.isRecording = true
      state.microphoneState = 'Recording now. It will stop automatically after 20 seconds.'
      scheduleAutoStop()
      render()
    }

    mediaRecorder.onstop = async () => {
      clearAutoStop()
      state.isRecording = false
      render()

      try {
        const audioBlob = new Blob(recordedChunks, {
          type: mediaRecorder?.mimeType || 'audio/webm',
        })

        if (!audioBlob.size) {
          throw new Error('No audio was captured. Try again and speak a bit closer to the mic.')
        }

        state.isLoading = true
        state.microphoneState = 'Uploading audio for transcription...'
        render()

        const payload = await postAudioForFlow(audioBlob)
        state.transcription = payload.transcription
        appendUserAndAssistantMessages(payload.transcription, payload.instruction, payload.result)
        state.microphoneState = 'Command completed successfully.'
      } catch (error) {
        registerFailure(toErrorMessage(error))
      } finally {
        state.isLoading = false
        cleanupRecorder()
        render()
      }
    }

    mediaRecorder.start(RECORDING_TIMESLICE_MS)
  } catch (error) {
    registerFailure(toErrorMessage(error))
  }
}

function stopRecording(statusMessage: string): void {
  state.microphoneState = statusMessage
  render()

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    if (mediaRecorder.state === 'recording') {
      mediaRecorder.requestData()
    }
    mediaRecorder.stop()
    return
  }

  cleanupRecorder()
}

function scheduleAutoStop(): void {
  clearAutoStop()
  stopTimerId = window.setTimeout(() => {
    if (state.isRecording) {
      stopRecording('20 second limit reached. Finalizing audio...')
    }
  }, MAX_RECORDING_MS)
}

function clearAutoStop(): void {
  if (stopTimerId !== null) {
    window.clearTimeout(stopTimerId)
    stopTimerId = null
  }
}

function cleanupRecorder(): void {
  clearAutoStop()

  if (activeStream) {
    activeStream.getTracks().forEach((track) => track.stop())
    activeStream = null
  }

  mediaRecorder = null
  recordedChunks = []
  state.isRecording = false
}

async function submitManualTranscription(rawValue: string): Promise<void> {
  const transcription = rawValue.trim()

  if (!transcription) {
    appendMessage({
      role: 'error',
      heading: 'Manual transcription',
      body: 'Type a command before sending it.',
    })
    render()
    return
  }

  try {
    state.isLoading = true
    state.microphoneState = 'Sending manual transcription to the backend...'
    render()

    const payload = await postManualTranscription(transcription)
    state.transcription = payload.transcription
    appendUserAndAssistantMessages(payload.transcription, payload.instruction, payload.result)
    state.microphoneState = 'Manual command completed successfully.'
  } catch (error) {
    registerFailure(toErrorMessage(error))
  } finally {
    state.isLoading = false
    render()
  }
}

function registerFailure(message: string): void {
  cleanupRecorder()
  state.isLoading = false
  state.transcriptionFailures += 1
  state.manualFallbackEnabled = state.transcriptionFailures >= MAX_AUTO_FAILURES || !state.supportsAudioCapture
  state.microphoneState = state.manualFallbackEnabled
    ? 'Recording failed twice. Manual transcription is now available.'
    : 'Recording failed. You can try again.'

  appendMessage({
    role: 'error',
    heading: 'Voice flow failed',
    body: message,
  })
  render()
}

function selectedTranscriptionLanguage(): string {
  return transcribeLangSelect.value.trim().toLowerCase()
}

async function postAudioForFlow(audioBlob: Blob): Promise<TranscribeFlowResponse> {
  const formData = new FormData()
  formData.append('file', audioBlob, inferAudioFilename(audioBlob.type))
  const lang = selectedTranscriptionLanguage()
  if (lang) {
    formData.append('language', lang)
  }

  const response = await fetchWithTimeout(
    `${API_BASE_URL}/transcribe`,
    {
      method: 'POST',
      body: formData,
    },
    REQUEST_TIMEOUT_MS,
    'Audio transcription took too long. Check the backend server and Groq integration.',
  )

  const data = await safeReadJson(response)

  if (!response.ok) {
    throw new Error(`Voice flow failed (${response.status}): ${stringifyData(data)}`)
  }

  return validateFlowResponse(data)
}

async function postManualTranscription(transcription: string): Promise<TranscribeFlowResponse> {
  const response = await fetchWithTimeout(
    `${API_BASE_URL}/transcribe`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ transcription }),
    },
    REQUEST_TIMEOUT_MS,
    'Manual transcription took too long. Check the backend server and Groq integration.',
  )

  const data = await safeReadJson(response)

  if (!response.ok) {
    throw new Error(`Manual flow failed (${response.status}): ${stringifyData(data)}`)
  }

  return validateFlowResponse(data)
}

function validateFlowResponse(data: unknown): TranscribeFlowResponse {
  if (!data || typeof data !== 'object') {
    throw new Error('The /transcribe endpoint did not return a valid JSON object.')
  }

  const candidate = data as Partial<TranscribeFlowResponse>

  if (typeof candidate.transcription !== 'string' || !candidate.transcription.trim()) {
    throw new Error('The /transcribe response is missing a valid transcription.')
  }

  if (!candidate.instruction || typeof candidate.instruction !== 'object') {
    throw new Error('The /transcribe response is missing the routed instruction.')
  }

  const instruction = candidate.instruction as Partial<InstructionResponse>
  if (
    typeof instruction.endpoint !== 'string' ||
    typeof instruction.method !== 'string' ||
    !instruction.params ||
    typeof instruction.params !== 'object' ||
    Array.isArray(instruction.params)
  ) {
    throw new Error('The /transcribe response returned an invalid instruction payload.')
  }

  return {
    transcription: candidate.transcription.trim(),
    instruction: {
      endpoint: instruction.endpoint,
      method: instruction.method.toUpperCase() as SupportedMethod,
      params: instruction.params,
    },
    result: candidate.result,
  }
}

function appendUserAndAssistantMessages(
  transcription: string,
  _instruction: InstructionResponse,
  result: unknown,
): void {
  appendMessage({
    role: 'user',
    heading: 'You',
    body: transcription,
  })

  appendMessage({
    role: 'assistant',
    heading: 'API response',
    body: 'The backend transcribed the audio, resolved the instruction, and executed the task action.',
    response: result,
  })
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<Response> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(timeoutMessage)
    }

    throw error
  } finally {
    window.clearTimeout(timeout)
  }
}

async function safeReadJson(response: Response): Promise<unknown> {
  const text = await response.text()

  if (!text) {
    return null
  }

  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`The server returned non-JSON content: ${text}`)
  }
}

function inferAudioFilename(mimeType: string): string {
  if (mimeType.includes('ogg')) return 'command.ogg'
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'command.m4a'
  if (mimeType.includes('wav')) return 'command.wav'
  return 'command.webm'
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim()

  if (!trimmed) {
    return ''
  }

  return trimmed.replace(/\/+$/, '')
}

function stringifyData(data: unknown): string {
  if (typeof data === 'string') return data
  return JSON.stringify(data, null, 2)
}

function appendMessage(message: Omit<ChatMessage, 'id' | 'timestamp'>): void {
  state.chat = [
    ...state.chat,
    {
      ...message,
      id: Date.now() + state.chat.length,
      timestamp: formatTime(),
    },
  ]
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return 'An unexpected error occurred.'
}

function render(): void {
  listeningChip.textContent = state.isLoading ? 'Working...' : state.isRecording ? 'Recording' : 'Stand by'
  listenToggleButton.textContent = state.isRecording ? 'Stop recording' : 'Record up to 20s'
  listenToggleButton.disabled = !state.supportsAudioCapture || state.isLoading
  transcribeLangSelect.disabled = state.isLoading || state.isRecording
  runManualButton.disabled = state.isLoading
  transcriptionInput.disabled = state.isLoading
  manualFallbackPanel.hidden = !state.manualFallbackEnabled

  pulseRing.dataset.active = state.isRecording ? 'true' : 'false'
  pulseRing.dataset.blocked = state.supportsAudioCapture ? 'false' : 'true'

  transcriptionInput.value = state.transcription
  microphoneState.textContent = state.microphoneState
  chatThread.innerHTML = state.chat.map(renderMessage).join('')
  chatThread.scrollTop = chatThread.scrollHeight
}

function renderMessage(message: ChatMessage): string {
  const hasResponse = typeof message.response !== 'undefined'

  return `
    <article class="message-row ${message.role}">
      <div class="message-bubble">
        <div class="message-meta">
          <span>${escapeHtml(message.heading)}</span>
          <span>${escapeHtml(message.timestamp)}</span>
        </div>
        <p class="message-body">${escapeHtml(message.body)}</p>
        ${
          hasResponse
            ? `
              <div class="message-block">
                <span class="message-label">Final API response</span>
                <pre>${escapeHtml(JSON.stringify(message.response, null, 2))}</pre>
              </div>
            `
            : ''
        }
      </div>
    </article>
  `
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function formatTime(): string {
  return new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function mustQuery<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`Missing required element: ${selector}`)
  return element
}
