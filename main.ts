// =============================================================================
// [Smart Chat - Gemini] 옵시디언 플러그인 (제작: Nero-KK)
// 기능: Gemini AI와 채팅, 노트 분석, @ 노트 참조, 텍스트 선택 질문
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
    Component,
    Editor,
    MarkdownView,
    SuggestModal
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

// 모델 정보 인터페이스
interface GeminiModel {
    name: string;
    displayName: string;
    description?: string;
}

// 참조된 노트 정보
interface ReferencedNote {
    file: TFile;
    content: string;
}

// 파일 제안 모달
class FileSuggestModal extends SuggestModal<TFile> {
    onChooseItem: (file: TFile) => void;

    constructor(app: App, onChooseItem: (file: TFile) => void) {
        super(app);
        this.onChooseItem = onChooseItem;
    }

    getSuggestions(query: string): TFile[] {
        const files = this.app.vault.getMarkdownFiles();
        return files.filter(file => 
            file.basename.toLowerCase().includes(query.toLowerCase())
        ).slice(0, 10);
    }

    renderSuggestion(file: TFile, el: HTMLElement) {
        el.createEl("div", { text: file.basename, cls: "suggestion-title" });
        el.createEl("small", { text: file.path, cls: "suggestion-note" });
    }

    onChooseSuggestion(file: TFile, evt: MouseEvent | KeyboardEvent) {
        this.onChooseItem(file);
    }
}

// 2. 채팅 화면 UI 클래스
class GeminiChatView extends ItemView {
    plugin: GeminiSmartChatPlugin;
    chatContainer: HTMLDivElement;
    useAllNotes: boolean = false;
    modeBtn: HTMLButtonElement;
    inputEl: HTMLTextAreaElement;
    referencedNotes: Map<string, ReferencedNote> = new Map();
    contextDisplay: HTMLDivElement;
    selectedTextContext: string = ''; // 선택된 텍스트 저장

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

        // 컨텍스트 표시 영역
        this.contextDisplay = container.createDiv({ cls: 'gemini-context-display' });
        this.contextDisplay.style.display = 'none';

        // 입력창 영역
        const inputContainer = container.createDiv({ cls: 'gemini-chat-input-form' });
        
        this.inputEl = inputContainer.createEl('textarea', {
            cls: 'gemini-chat-input',
            attr: { placeholder: '질문을 입력하세요... (@로 노트 참조)' }
        });

        // @ 입력 시 파일 제안
        this.inputEl.addEventListener('input', (e) => {
            const cursorPos = this.inputEl.selectionStart;
            const textBeforeCursor = this.inputEl.value.substring(0, cursorPos);
            const lastAtIndex = textBeforeCursor.lastIndexOf('@');
            
            if (lastAtIndex !== -1 && cursorPos - lastAtIndex <= 50) {
                const query = textBeforeCursor.substring(lastAtIndex + 1);
                if (!query.includes(' ') && !query.includes('\n')) {
                    this.showFileSuggestion(lastAtIndex);
                }
            }
        });

        const sendBtn = inputContainer.createEl('button', {
            cls: 'gemini-chat-send-button',
            text: '전송'
        });

        const sendMessage = async () => {
            const userMessage = this.inputEl.value.trim();
            if (!userMessage) return;

            // API 키 체크
            if (!this.plugin.settings.apiKey) {
                new Notice('⚠️ API Key를 설정에서 입력해주세요.');
                return;
            }

            this.addMessage(userMessage, 'user');
            this.inputEl.value = '';
            this.inputEl.disabled = true;
            sendBtn.disabled = true;
            sendBtn.innerText = '처리 중...';

            if (Platform.isMobile) this.inputEl.blur();

            try {
                let contextContent = "";
                let sourceName = "없음";

                // 선택된 텍스트 우선 처리
                if (this.selectedTextContext) {
                    contextContent = this.selectedTextContext;
                    sourceName = "선택된 텍스트";
                }
                // @ 참조 노트 처리
                else if (this.referencedNotes.size > 0) {
                    const references: string[] = [];
                    this.referencedNotes.forEach((note, name) => {
                        references.push(`[Referenced Note: ${name}]\n${note.content}\n`);
                    });
                    contextContent = references.join("\n---\n");
                    sourceName = `참조된 노트 (${this.referencedNotes.size}개)`;
                } else if (this.useAllNotes) {
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

                // 참조 초기화
                this.referencedNotes.clear();
                this.selectedTextContext = '';
                this.updateContextDisplay();

            } catch (error) {
                console.error("Gemini Plugin Error:", error);
                const errorMessage = error instanceof Error ? error.message : String(error);
                this.addMessage(`❌ 오류: ${errorMessage}`, 'error');
            } finally {
                this.inputEl.disabled = false;
                sendBtn.disabled = false;
                sendBtn.innerText = '전송';
                if (!Platform.isMobile) this.inputEl.focus();
            }
        };

        sendBtn.onclick = sendMessage;
        this.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });
    }

    showFileSuggestion(atIndex: number): void {
        new FileSuggestModal(this.app, async (file) => {
            // @ 이후 텍스트 제거하고 파일명으로 대체
            const cursorPos = this.inputEl.selectionStart;
            const before = this.inputEl.value.substring(0, atIndex);
            const after = this.inputEl.value.substring(cursorPos);
            
            // 참조 추가
            const content = await this.app.vault.read(file);
            this.referencedNotes.set(file.basename, { file, content });
            
            // 입력창에서 @ 제거
            this.inputEl.value = before + after;
            this.inputEl.setSelectionRange(before.length, before.length);
            
            // 컨텍스트 표시 업데이트
            this.updateContextDisplay();
            
            new Notice(`📎 ${file.basename} 참조 추가됨`);
        }).open();
    }

    updateContextDisplay(): void {
        this.contextDisplay.empty();
        
        const totalReferences = this.referencedNotes.size + (this.selectedTextContext ? 1 : 0);
        
        if (totalReferences === 0) {
            this.contextDisplay.style.display = 'none';
            return;
        }

        this.contextDisplay.style.display = 'block';
        this.contextDisplay.style.padding = '8px';
        this.contextDisplay.style.margin = '8px 0';
        this.contextDisplay.style.backgroundColor = 'var(--background-secondary)';
        this.contextDisplay.style.borderRadius = '6px';
        this.contextDisplay.style.border = '1px solid var(--background-modifier-border)';

        const title = this.contextDisplay.createDiv();
        title.setText(`📎 참조된 컨텍스트 (${totalReferences})`);
        title.style.fontWeight = 'bold';
        title.style.marginBottom = '8px';

        // 선택된 텍스트 표시
        if (this.selectedTextContext) {
            const textItem = this.contextDisplay.createDiv();
            textItem.style.display = 'flex';
            textItem.style.justifyContent = 'space-between';
            textItem.style.alignItems = 'center';
            textItem.style.padding = '4px 8px';
            textItem.style.margin = '2px 0';
            textItem.style.backgroundColor = 'var(--background-primary)';
            textItem.style.borderRadius = '4px';
            textItem.style.border = '2px solid var(--interactive-accent)';

            const nameSpan = textItem.createSpan({ text: '✂️ 선택된 텍스트' });
            nameSpan.style.fontWeight = 'bold';
            nameSpan.style.color = 'var(--interactive-accent)';
            
            const previewSpan = textItem.createSpan();
            const preview = this.selectedTextContext.slice(0, 50) + (this.selectedTextContext.length > 50 ? '...' : '');
            previewSpan.setText(` (${preview})`);
            previewSpan.style.fontSize = '0.85em';
            previewSpan.style.opacity = '0.7';
            previewSpan.style.marginLeft = '8px';
            
            const removeBtn = textItem.createEl('button', { text: '✕' });
            removeBtn.style.background = 'none';
            removeBtn.style.border = 'none';
            removeBtn.style.cursor = 'pointer';
            removeBtn.style.color = 'var(--text-muted)';
            removeBtn.onclick = () => {
                this.selectedTextContext = '';
                this.updateContextDisplay();
                new Notice('선택된 텍스트 참조 제거됨');
            };
        }

        // 참조된 노트 표시
        this.referencedNotes.forEach((note, name) => {
            const noteItem = this.contextDisplay.createDiv();
            noteItem.style.display = 'flex';
            noteItem.style.justifyContent = 'space-between';
            noteItem.style.alignItems = 'center';
            noteItem.style.padding = '4px 8px';
            noteItem.style.margin = '2px 0';
            noteItem.style.backgroundColor = 'var(--background-primary)';
            noteItem.style.borderRadius = '4px';

            const nameSpan = noteItem.createSpan({ text: name });
            
            const removeBtn = noteItem.createEl('button', { text: '✕' });
            removeBtn.style.background = 'none';
            removeBtn.style.border = 'none';
            removeBtn.style.cursor = 'pointer';
            removeBtn.style.color = 'var(--text-muted)';
            removeBtn.onclick = () => {
                this.referencedNotes.delete(name);
                this.updateContextDisplay();
                new Notice(`${name} 참조 제거됨`);
            };
        });
    }

    // 선택된 텍스트로 채팅 시작
    async startChatWithSelection(selectedText: string): Promise<void> {
        console.log('startChatWithSelection called with text:', selectedText.slice(0, 100));
        
        // 선택된 텍스트를 컨텍스트로 저장
        this.selectedTextContext = selectedText;
        console.log('selectedTextContext set:', this.selectedTextContext.slice(0, 100));
        
        // 컨텍스트 표시 업데이트
        this.updateContextDisplay();
        
        // 메시지로도 표시
        const preview = selectedText.slice(0, 100) + (selectedText.length > 100 ? '...' : '');
        this.addMessage(`✂️ 선택된 텍스트가 컨텍스트로 추가되었습니다.\n\n"${preview}"`, 'context');
        
        // 입력창에 포커스
        this.inputEl.focus();
        this.inputEl.placeholder = '선택된 텍스트에 대해 질문하세요...';
        
        new Notice('✂️ 선택된 텍스트가 컨텍스트로 추가되었습니다');
        console.log('startChatWithSelection completed');
    }

    updateModeButton(): void {
        if (!this.modeBtn) return;
        this.modeBtn.innerText = this.useAllNotes ? '📚 전체' : '📄 현재';
        this.modeBtn.className = `mode-toggle-btn ${this.useAllNotes ? 'mode-all' : 'mode-current'}`;
    }

    addMessage(text: string, sender: 'user' | 'ai' | 'error' | 'context'): void {
        const msgDiv = this.chatContainer.createDiv({ cls: `chat-message ${sender}` });
        
        // 메시지 컨테이너
        const contentDiv = msgDiv.createDiv({ cls: 'message-content' });
        contentDiv.style.userSelect = 'text'; // 드래그 가능하게
        
        if (sender === 'ai') {
            MarkdownRenderer.render(
                this.app, 
                text, 
                contentDiv, 
                '', 
                new Component()
            );
            
            // 복사 버튼 추가
            const copyBtn = msgDiv.createEl('button', { 
                cls: 'message-copy-btn',
                text: '📋 복사'
            });
            copyBtn.style.marginTop = '8px';
            copyBtn.style.padding = '4px 8px';
            copyBtn.style.fontSize = '0.85em';
            copyBtn.style.cursor = 'pointer';
            copyBtn.style.backgroundColor = 'var(--interactive-accent)';
            copyBtn.style.color = 'var(--text-on-accent)';
            copyBtn.style.border = 'none';
            copyBtn.style.borderRadius = '4px';
            
            copyBtn.onclick = async () => {
                await navigator.clipboard.writeText(text);
                copyBtn.setText('✓ 복사됨');
                setTimeout(() => copyBtn.setText('📋 복사'), 2000);
            };
        } else if (sender === 'context') {
            contentDiv.style.fontStyle = 'italic';
            contentDiv.style.opacity = '0.9';
            contentDiv.style.backgroundColor = 'var(--background-secondary-alt)';
            contentDiv.style.padding = '12px';
            contentDiv.style.borderRadius = '6px';
            contentDiv.style.border = '2px solid var(--interactive-accent)';
            contentDiv.style.whiteSpace = 'pre-wrap';
            contentDiv.setText(text);
        } else {
            contentDiv.setText(text);
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

            if (data.error) {
                throw new Error(`${data.error.message} (코드: ${data.error.code})`);
            }

            if (!data.candidates || data.candidates.length === 0) {
                if (data.promptFeedback?.blockReason) {
                    return `⚠️ 대화가 차단되었습니다. 사유: ${data.promptFeedback.blockReason}`;
                }
                throw new Error("API에서 유효한 답변을 받지 못했습니다.");
            }

            const candidate = data.candidates[0];
            
            if (candidate.finishReason !== 'STOP' && !candidate.content) {
                return `⚠️ 답변 생성 중단됨. 사유: ${candidate.finishReason}`;
            }

            return candidate.content.parts[0].text;

        } catch (err: any) {
            if (err.status === 403) {
                throw new Error("API 키가 올바르지 않거나 권한이 없습니다.");
            }
            if (err.status === 404) {
                throw new Error(`모델명(${modelName})을 찾을 수 없습니다.`);
            }
            if (err.status === 429) {
                throw new Error("API 사용량이 초과되었습니다.");
            }
            throw err;
        }
    }

    async onClose(): Promise<void> {
        // cleanup
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

        // 선택된 텍스트로 채팅 시작 명령어
        this.addCommand({
            id: 'chat-with-selection',
            name: 'Chat with selection',
            editorCallback: async (editor: Editor, view: MarkdownView) => {
                const selection = editor.getSelection();
                if (!selection) {
                    new Notice('⚠️ 텍스트를 먼저 선택해주세요.');
                    return;
                }
                
                // 기존에 열린 뷰가 있는지 확인
                let leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_GEMINI_CHAT);
                let chatView: GeminiChatView;
                
                if (leaves.length > 0) {
                    // 이미 열려있으면 재사용
                    chatView = leaves[0].view as GeminiChatView;
                    this.app.workspace.revealLeaf(leaves[0]);
                } else {
                    // 없으면 새로 생성
                    const leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true);
                    await leaf.setViewState({
                        type: VIEW_TYPE_GEMINI_CHAT,
                        active: true,
                    });
                    this.app.workspace.revealLeaf(leaf);
                    
                    // 뷰가 완전히 로드될 때까지 대기
                    await new Promise(resolve => setTimeout(resolve, 100));
                    
                    leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_GEMINI_CHAT);
                    if (leaves.length === 0) {
                        new Notice('❌ 채팅창을 열 수 없습니다.');
                        return;
                    }
                    chatView = leaves[0].view as GeminiChatView;
                }
                
                // 선택된 텍스트로 채팅 시작
                await chatView.startChatWithSelection(selection);
            }
        });
        
        this.addSettingTab(new GeminiChatSettingTab(this.app, this));
    }

    async activateView(): Promise<void> {
        const { workspace } = this.app;
        
        // 이미 열려있는 뷰가 있는지 확인
        let leaf = workspace.getLeavesOfType(VIEW_TYPE_GEMINI_CHAT)[0];
        
        if (!leaf) {
            // 없으면 새로 생성
            leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
            await leaf.setViewState({
                type: VIEW_TYPE_GEMINI_CHAT,
                active: true,
            });
        }
        
        workspace.revealLeaf(leaf);
    }

    async loadSettings(): Promise<void> { 
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); 
    }
    
    async saveSettings(): Promise<void> { 
        await this.saveData(this.settings); 
    }

    async testConnection(): Promise<{ success: boolean; message: string }> {
        const { apiKey, modelName } = this.settings;

        if (!apiKey) {
            return { success: false, message: 'API 키를 입력해주세요.' };
        }

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

        try {
            const response = await requestUrl({
                url: url,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    contents: [{ 
                        parts: [{ text: 'Hello' }] 
                    }] 
                }),
                throw: false
            });

            if (response.status === 200) {
                return { 
                    success: true, 
                    message: `✅ 연결 성공! (${modelName})` 
                };
            } else if (response.status === 403) {
                return { 
                    success: false, 
                    message: '❌ API 키가 올바르지 않습니다.' 
                };
            } else if (response.status === 404) {
                return { 
                    success: false, 
                    message: `❌ 모델 '${modelName}'을 찾을 수 없습니다.` 
                };
            } else {
                return { 
                    success: false, 
                    message: `❌ 연결 실패 (상태 코드: ${response.status})` 
                };
            }
        } catch (error) {
            return { 
                success: false, 
                message: `❌ 연결 오류: ${error.message}` 
            };
        }
    }

    async fetchAvailableModels(): Promise<GeminiModel[]> {
        const { apiKey } = this.settings;

        if (!apiKey) {
            return [];
        }

        const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;

        try {
            const response = await requestUrl({
                url: url,
                method: 'GET',
                headers: { 'Content-Type': 'application/json' },
                throw: false
            });

            if (response.status === 200) {
                const data = response.json;
                if (data.models && Array.isArray(data.models)) {
                    return data.models
                        .filter((model: any) => 
                            model.supportedGenerationMethods?.includes('generateContent')
                        )
                        .map((model: any) => ({
                            name: model.name.replace('models/', ''),
                            displayName: model.displayName || model.name.replace('models/', ''),
                            description: model.description
                        }))
                        .sort((a: GeminiModel, b: GeminiModel) => 
                            b.name.localeCompare(a.name)
                        );
                }
            }
            return [];
        } catch (error) {
            console.error('Failed to fetch models:', error);
            return [];
        }
    }
}

// 4. 설정 화면
class GeminiChatSettingTab extends PluginSettingTab {
    plugin: GeminiSmartChatPlugin;
    private modelListContainer: HTMLElement | null = null;
    private showModelList: boolean = false;
    private modelNameInput: HTMLInputElement | null = null;
    private availableModels: GeminiModel[] = [];
    private isLoadingModels: boolean = false;

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
                    this.availableModels = [];
                    if (this.showModelList && this.modelListContainer) {
                        this.modelListContainer.empty();
                        const loadingMsg = this.modelListContainer.createDiv();
                        loadingMsg.setText('API 키를 입력하고 토글을 다시 켜주세요.');
                        loadingMsg.style.textAlign = 'center';
                        loadingMsg.style.padding = '20px';
                        loadingMsg.style.opacity = '0.7';
                    }
                }));

        const modelSetting = new Setting(containerEl)
            .setName('Model Name')
            .setDesc('사용할 모델명을 입력하세요.')
            .addText(text => {
                this.modelNameInput = text.inputEl;
                text
                    .setValue(this.plugin.settings.modelName)
                    .onChange(async (v) => { 
                        this.plugin.settings.modelName = v; 
                        await this.plugin.saveSettings(); 
                    });
            });

        modelSetting.addButton(button => button
            .setButtonText('연결 테스트')
            .setCta()
            .onClick(async () => {
                button.setDisabled(true);
                button.setButtonText('테스트 중...');
                
                const result = await this.plugin.testConnection();
                new Notice(result.message, result.success ? 3000 : 5000);
                
                button.setDisabled(false);
                button.setButtonText('연결 테스트');
            }));

        const modelListToggle = new Setting(containerEl)
            .setName('사용 가능한 모델 목록')
            .setDesc('API 키로 사용 가능한 Gemini 모델 목록을 불러옵니다.')
            .addToggle(toggle => toggle
                .setValue(this.showModelList)
                .onChange(async (value) => {
                    this.showModelList = value;
                    if (value && this.availableModels.length === 0) {
                        await this.loadAvailableModels();
                    } else {
                        this.updateModelListDisplay();
                    }
                }));

        this.modelListContainer = containerEl.createDiv({ cls: 'gemini-model-list-container' });
        this.modelListContainer.style.display = 'none';
        this.modelListContainer.style.marginLeft = '0';
        this.modelListContainer.style.marginTop = '10px';
        this.modelListContainer.style.border = '1px solid var(--background-modifier-border)';
        this.modelListContainer.style.borderRadius = '6px';
        this.modelListContainer.style.padding = '10px';
        this.modelListContainer.style.backgroundColor = 'var(--background-secondary)';
        this.modelListContainer.style.maxHeight = '300px';
        this.modelListContainer.style.overflowY = 'auto';

        containerEl.createEl('div', { 
            cls: 'setting-item-description',
            text: ''
        }).createEl('a', {
            text: 'Google AI Studio에서 API 키 발급받기',
            href: 'https://aistudio.google.com/app/apikey'
        });
    }

    async loadAvailableModels(): Promise<void> {
        if (!this.plugin.settings.apiKey) {
            new Notice('⚠️ API 키를 먼저 입력해주세요.');
            this.showModelList = false;
            this.updateModelListDisplay();
            return;
        }

        if (!this.modelListContainer) return;

        this.isLoadingModels = true;
        this.modelListContainer.style.display = 'block';
        this.modelListContainer.empty();

        const loadingMsg = this.modelListContainer.createDiv();
        loadingMsg.setText('🔄 모델 목록을 불러오는 중...');
        loadingMsg.style.textAlign = 'center';
        loadingMsg.style.padding = '20px';

        this.availableModels = await this.plugin.fetchAvailableModels();
        this.isLoadingModels = false;

        this.modelListContainer.empty();

        if (this.availableModels.length === 0) {
            const errorMsg = this.modelListContainer.createDiv();
            errorMsg.setText('❌ 모델을 불러올 수 없습니다. API 키를 확인해주세요.');
            errorMsg.style.textAlign = 'center';
            errorMsg.style.padding = '20px';
            errorMsg.style.color = 'var(--text-error)';
            return;
        }

        const countMsg = this.modelListContainer.createDiv();
        countMsg.setText(`총 ${this.availableModels.length}개의 모델 사용 가능`);
        countMsg.style.textAlign = 'center';
        countMsg.style.padding = '5px';
        countMsg.style.marginBottom = '10px';
        countMsg.style.fontWeight = 'bold';
        countMsg.style.fontSize = '0.9em';
        countMsg.style.borderBottom = '1px solid var(--background-modifier-border)';

        this.availableModels.forEach(model => {
            const modelItem = this.modelListContainer!.createDiv({ cls: 'gemini-model-item' });
            modelItem.style.padding = '8px';
            modelItem.style.margin = '4px 0';
            modelItem.style.cursor = 'pointer';
            modelItem.style.borderRadius = '4px';
            modelItem.style.transition = 'background-color 0.2s';

            const modelTitle = modelItem.createDiv();
            modelTitle.style.fontWeight = 'bold';
            modelTitle.style.marginBottom = '2px';
            modelTitle.setText(model.displayName);

            const modelId = modelItem.createDiv();
            modelId.style.fontSize = '0.85em';
            modelId.style.opacity = '0.7';
            modelId.setText(model.name);

            if (model.description) {
                const modelDesc = modelItem.createDiv();
                modelDesc.style.fontSize = '0.8em';
                modelDesc.style.marginTop = '4px';
                modelDesc.style.opacity = '0.6';
                modelDesc.style.fontStyle = 'italic';
                modelDesc.setText(model.description.slice(0, 100) + (model.description.length > 100 ? '...' : ''));
            }

            if (this.plugin.settings.modelName === model.name) {
                modelItem.style.backgroundColor = 'var(--interactive-accent)';
                modelItem.style.color = 'var(--text-on-accent)';
            }

            modelItem.addEventListener('mouseenter', () => {
                if (this.plugin.settings.modelName !== model.name) {
                    modelItem.style.backgroundColor = 'var(--background-modifier-hover)';
                }
            });

            modelItem.addEventListener('mouseleave', () => {
                if (this.plugin.settings.modelName !== model.name) {
                    modelItem.style.backgroundColor = 'transparent';
                }
            });

            modelItem.addEventListener('click', async () => {
                this.plugin.settings.modelName = model.name;
                await this.plugin.saveSettings();
                
                if (this.modelNameInput) {
                    this.modelNameInput.value = model.name;
                }

                new Notice(`모델 선택: ${model.displayName}`);
                
                this.display();
                this.showModelList = true;
                await this.loadAvailableModels();
            });
        });
    }

    updateModelListDisplay(): void {
        if (this.modelListContainer) {
            this.modelListContainer.style.display = this.showModelList ? 'block' : 'none';
        }
    }
}