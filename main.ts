// =============================================================================
// [Smart Chat - Gemini] 옵시디언 플러그인 (제작: Nero-KK)
// 기능: Gemini AI와 채팅, 현재 노트 및 전체 보관함 분석, 상세 에러 핸들링 추가
// =============================================================================

import { 
    App, 
    ItemView, 
    Notice, 
    Plugin, 
    PluginSettingTab, 
    Setting, 
    WorkspaceLeaf, 
    requestUrl, 
    MarkdownRenderer, 
    TFile, 
    Platform,
    Component
} from 'obsidian';

// 1. 설정 정보 저장 그릇
interface GeminiChatSettings {
    apiKey: string;
    modelName: string;
}

const DEFAULT_SETTINGS: GeminiChatSettings = {
    apiKey: '',
    modelName: 'gemini-1.5-flash-002'
};

const VIEW_TYPE_GEMINI_CHAT = 'smart-chat-gemini';

// 2. 채팅 화면 UI 클래스
class GeminiChatView extends ItemView {
    plugin: GeminiSmartChatPlugin;
    chatContainer: HTMLDivElement;
    useAllNotes: boolean = false;
    modeBtn: HTMLButtonElement;

    constructor(leaf: WorkspaceLeaf, plugin: GeminiSmartChatPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string { 
        return VIEW_TYPE_GEMINI_CHAT; 
    }
    
    getDisplayText(): string { 
        return 'Smart Chat - Gemini'; 
    }
    
    getIcon(): string { 
        return 'bot'; 
    }

    async onOpen(): Promise<void> {
        const container = this.contentEl as HTMLElement;
        container.empty(); 
        container.classList.add('gemini-chat-container');

        // 상단 헤더
        const header = container.createDiv({ cls: 'gemini-chat-header' });
        header.createEl('h4', { text: 'Smart Chat - Gemini', cls: 'header-title' });
        
        this.modeBtn = header.createEl('button', { cls: 'mode-toggle-btn' });
        this.updateModeButton();
        
        this.modeBtn.onclick = () => {
            this.useAllNotes = !this.useAllNotes;
            this.updateModeButton();
            new Notice(this.useAllNotes ? '📚 전체 노트 분석 모드' : '📄 현재 노트 분석 모드');
        };

        // 채팅 메시지 영역
        this.chatContainer = container.createDiv({ cls: 'gemini-chat-messages' });

        // 입력창 영역
        const inputContainer = container.createDiv({ cls: 'gemini-chat-input-form' });
        
        const inputEl = inputContainer.createEl('textarea', {
            cls: 'gemini-chat-input',
            attr: { placeholder: '질문을 입력하세요...' }
        });

        const sendBtn = inputContainer.createEl('button', {
            cls: 'gemini-chat-send-button',
            text: '전송'
        });

        const sendMessage = async () => {
            const userMessage = inputEl.value.trim();
            if (!userMessage) return;

            // API 키 체크
            if (!this.plugin.settings.apiKey) {
                new Notice('⚠️ API Key를 설정에서 입력해주세요.');
                return;
            }

            this.addMessage(userMessage, 'user');
            inputEl.value = '';
            inputEl.disabled = true;
            sendBtn.disabled = true;
            sendBtn.innerText = '처리 중...';

            if (Platform.isMobile) inputEl.blur();

            try {
                let contextContent = "";
                let sourceName = "없음";

                if (this.useAllNotes) {
                    const files = this.app.vault.getMarkdownFiles();
                    sourceName = `전체 보관함 (${files.length}개 파일)`;
                    
                    const fileContents = await Promise.all(files.map(async (file) => {
                        try {
                            const content = await this.app.vault.read(file);
                            return `[File: ${file.path}]\n${content}\n`;
                        } catch { 
                            return ""; 
                        }
                    }));
                    contextContent = fileContents.join("\n---\n").slice(0, 50000);
                } else {
                    const activeFile = this.app.workspace.getActiveFile();
                    if (activeFile instanceof TFile) {
                        contextContent = await this.app.vault.read(activeFile);
                        sourceName = activeFile.path;
                    }
                }

                const prompt = `[Context From Obsidian: ${sourceName}]\n${contextContent}\n\n[User Question]: ${userMessage}`;
                const response = await this.callGeminiApi(prompt);
                this.addMessage(response, 'ai');

            } catch (error) {
                console.error("Gemini Plugin Error:", error);
                const errorMessage = error instanceof Error ? error.message : String(error);
                this.addMessage(`❌ 오류: ${errorMessage}`, 'error');
            } finally {
                inputEl.disabled = false;
                sendBtn.disabled = false;
                sendBtn.innerText = '전송';
                if (!Platform.isMobile) inputEl.focus();
            }
        };

        sendBtn.onclick = sendMessage;
        inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });
    }

    updateModeButton(): void {
        if (!this.modeBtn) return;
        this.modeBtn.innerText = this.useAllNotes ? '📚 전체' : '📄 현재';
        this.modeBtn.className = `mode-toggle-btn ${this.useAllNotes ? 'mode-all' : 'mode-current'}`;
    }

    addMessage(text: string, sender: 'user' | 'ai' | 'error'): void {
        const msgDiv = this.chatContainer.createDiv({ cls: `chat-message ${sender}` });
        if (sender === 'ai') {
            MarkdownRenderer.render(
                this.app, 
                text, 
                msgDiv, 
                '', 
                new Component()
            );
        } else {
            msgDiv.setText(text);
        }
        msgDiv.scrollIntoView({ behavior: 'smooth' });
    }

    async callGeminiApi(prompt: string): Promise<string> {
        const { apiKey, modelName } = this.plugin.settings;
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

        try {
            const response = await requestUrl({
                url: url,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    contents: [{ 
                        parts: [{ text: prompt }] 
                    }] 
                })
            });

            const data = response.json;

            // 1. 에러 응답 처리
            if (data.error) {
                throw new Error(`${data.error.message} (코드: ${data.error.code})`);
            }

            // 2. 응답 구조 검증
            if (!data.candidates || data.candidates.length === 0) {
                if (data.promptFeedback?.blockReason) {
                    return `⚠️ 대화가 차단되었습니다. 사유: ${data.promptFeedback.blockReason}`;
                }
                throw new Error("API에서 유효한 답변을 받지 못했습니다. (응답 구조 이상)");
            }

            const candidate = data.candidates[0];
            
            // 3. 답변 생성 실패 사유 체크
            if (candidate.finishReason !== 'STOP' && !candidate.content) {
                return `⚠️ 답변 생성 중단됨. 사유: ${candidate.finishReason}`;
            }

            return candidate.content.parts[0].text;

        } catch (err: any) {
            // HTTP 에러 처리
            if (err.status === 403) {
                throw new Error("API 키가 올바르지 않거나 권한이 없습니다.");
            }
            if (err.status === 404) {
                throw new Error(`모델명(${modelName})을 찾을 수 없습니다. 설정에서 모델명을 확인해 주세요.`);
            }
            if (err.status === 429) {
                throw new Error("API 사용량이 초과되었습니다. 잠시 후 다시 시도해 주세요.");
            }
            
            throw err;
        }
    }

    async onClose(): Promise<void> {
        // cleanup if needed
    }
}

// 3. 플러그인 메인 클래스
export default class GeminiSmartChatPlugin extends Plugin {
    settings: GeminiChatSettings;

    async onload(): Promise<void> {
        await this.loadSettings();
        
        this.registerView(
            VIEW_TYPE_GEMINI_CHAT, 
            (leaf) => new GeminiChatView(leaf, this)
        );
        
        this.addRibbonIcon('bot', 'Smart Chat - Gemini', () => {
            this.activateView();
        });
        
        this.addSettingTab(new GeminiChatSettingTab(this.app, this));
    }

    async activateView(): Promise<void> {
        const { workspace } = this.app;
        
        workspace.detachLeavesOfType(VIEW_TYPE_GEMINI_CHAT);
        
        const leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
        await leaf.setViewState({
            type: VIEW_TYPE_GEMINI_CHAT,
            active: true,
        });
        
        workspace.revealLeaf(leaf);
    }

    async loadSettings(): Promise<void> { 
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); 
    }
    
    async saveSettings(): Promise<void> { 
        await this.saveData(this.settings); 
    }
}

// 4. 설정 화면
class GeminiChatSettingTab extends PluginSettingTab {
    plugin: GeminiSmartChatPlugin;

    constructor(app: App, plugin: GeminiSmartChatPlugin) { 
        super(app, plugin); 
        this.plugin = plugin; 
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'Smart Chat - Gemini 설정' });
        
        new Setting(containerEl)
            .setName('API Key')
            .setDesc('Google AI Studio에서 발급받은 API 키를 입력하세요.')
            .addText(text => text
                .setPlaceholder('AIza...')
                .setValue(this.plugin.settings.apiKey)
                .onChange(async (v) => { 
                    this.plugin.settings.apiKey = v; 
                    await this.plugin.saveSettings(); 
                }));

        new Setting(containerEl)
            .setName('Model Name')
            .setDesc('사용할 모델명을 입력하세요. (기본값: gemini-1.5-flash-002)')
            .addText(text => text
                .setValue(this.plugin.settings.modelName)
                .onChange(async (v) => { 
                    this.plugin.settings.modelName = v; 
                    await this.plugin.saveSettings(); 
                }));
    }
}