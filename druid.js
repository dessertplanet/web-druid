/**
 * druid web - Web-based editor and REPL for monome crow
 * Maiden-inspired interface with Monaco editor
 */

class CrowConnection {
    constructor() {
        this.port = null;
        this.reader = null;
        this.writer = null;
        this.isConnected = false;
        this.readableStreamClosed = null;
        this.writableStreamClosed = null;
        this.onDataReceived = null;
        this.onConnectionChange = null;
        this.lineBuffer = ''; // Buffer for incomplete lines
    }

    async connect() {
        try {
            this.port = await navigator.serial.requestPort({
                filters: [{ usbVendorId: 0x0483, usbProductId: 0x5740 }]
            });

            await this.port.open({ 
                baudRate: 115200,
                dataBits: 8,
                stopBits: 1,
                parity: 'none',
                flowControl: 'none'
            });

            this.isConnected = true;
            
            const textDecoder = new TextDecoderStream();
            this.readableStreamClosed = this.port.readable.pipeTo(textDecoder.writable);
            this.reader = textDecoder.readable.getReader();

            const textEncoder = new TextEncoderStream();
            this.writableStreamClosed = textEncoder.readable.pipeTo(this.port.writable);
            this.writer = textEncoder.writable.getWriter();

            this.startReading();

            if (this.onConnectionChange) {
                this.onConnectionChange(true);
            }

            return true;
        } catch (error) {
            console.error('Connection error:', error);
            if (this.onConnectionChange) {
                this.onConnectionChange(false, error.message);
            }
            return false;
        }
    }

    async startReading() {
        try {
            while (this.isConnected) {
                const { value, done } = await this.reader.read();
                if (done) break;
                if (value && this.onDataReceived) {
                    // Add to buffer
                    this.lineBuffer += value;
                    
                    // Process complete lines (ending with \n)
                    let newlineIndex;
                    while ((newlineIndex = this.lineBuffer.indexOf('\n')) !== -1) {
                        const line = this.lineBuffer.substring(0, newlineIndex);
                        this.lineBuffer = this.lineBuffer.substring(newlineIndex + 1);
                        
                        if (line) {
                            this.onDataReceived(line);
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Read error:', error);
            if (this.isConnected) {
                // Close streams but keep port reference
                this.isConnected = false;
                this.shouldReconnect = false;
                
                if (this.reader) {
                    await this.reader.cancel().catch(() => {});
                }
                if (this.writer) {
                    await this.writer.close().catch(() => {});
                }
                
                this.reader = null;
                this.writer = null;
                this.lineBuffer = ''; // Clear buffer on disconnect
                
                if (this.port) {
                    await this.port.close().catch(() => {});
                    this.port = null;
                }
                
                if (this.onConnectionChange) {
                    this.onConnectionChange(false, 'device disconnected. please reconnect > ' );
                }
            }
        }
    }

    async write(data) {
        if (!this.isConnected || !this.writer) {
            throw new Error('Not connected');
        }
        
        try {
            await this.writer.write(data);
        } catch (error) {
            console.error('Write error:', error);
            throw error;
        }
    }

    async writeLine(line) {
        await this.write(line + '\r\n');
    }

    async disconnect() {
        this.isConnected = false;

        if (this.reader) {
            await this.reader.cancel().catch(() => {});
            await this.readableStreamClosed.catch(() => {});
        }

        if (this.writer) {
            await this.writer.close().catch(() => {});
            await this.writableStreamClosed.catch(() => {});
        }

        if (this.port) {
            await this.port.close().catch(() => {});
        }

        this.port = null;
        this.reader = null;
        this.writer = null;

        if (this.onConnectionChange) {
            this.onConnectionChange(false);
        }
    }
}

class DruidApp {
    constructor() {
        this.crow = new CrowConnection();
        this.editor = null;
        this.replEditor = null;
        this.replAutocompleteEnabled = true;
        this.splitState = null;
        this._resizeRaf = null;
        this._suppressEditorChange = false;
        this.scriptName = 'untitled.lua';
        this.scriptModified = false;
        this.currentFile = null;

        // Best-effort Lua symbol tracking for IntelliSense + linting.
        // Tracks globals defined across the session (uploads + REPL sends).
        this._sessionLuaGlobals = new Map();
        // Tracks the last parsed symbol index for the main editor model.
        this._editorLuaSymbolIndex = null;
        this._editorLuaSymbolIndexVersionId = null;
        
        // Command history for REPL
        this.commandHistory = [];
        this.historyIndex = -1;
        this.currentInput = '';
        this.isNavigatingHistory = false; // Flag to prevent history reset during navigation
        this.commandHistory = [];
        this.historyIndex = -1;
        this.currentInput = '';
        
        this.initializeUI();
        this.checkBrowserSupport();
        this.setupEventListeners();
        this.initializeEditor();
        this.setupSplitPane();
    }

    compareLuaPositions(a, b) {
        if (!a || !b) return 0;
        const aLine = a.line ?? 0;
        const bLine = b.line ?? 0;
        if (aLine !== bLine) return aLine - bLine;
        const aCol = a.column ?? 0;
        const bCol = b.column ?? 0;
        return aCol - bCol;
    }

    extractLuaSymbolIndex(code) {
        if (typeof luaparse === 'undefined') return null;

        let ast;
        try {
            ast = luaparse.parse(String(code), {
                luaVersion: '5.3',
                locations: true,
                ranges: false,
                scope: false,
                comments: false
            });
        } catch {
            return null;
        }

        const defsByName = new Map();
        const refs = [];

        const isIdentifier = (n) => n && typeof n === 'object' && n.type === 'Identifier' && typeof n.name === 'string';
        const toPos = (loc) => {
            const line = loc?.start?.line;
            const column0 = loc?.start?.column;
            if (typeof line !== 'number' || typeof column0 !== 'number') return null;
            return { line, column: column0 + 1 };
        };

        const getDeclarationInfo = (node, parent, parentKey) => {
            if (!isIdentifier(node) || !parent || typeof parent !== 'object') return null;

            if (parent.type === 'LocalStatement' && parentKey === 'variables') {
                return { name: node.name, kind: 'variable', scope: 'local' };
            }
            if (parent.type === 'AssignmentStatement' && parentKey === 'variables') {
                return { name: node.name, kind: 'variable', scope: 'global' };
            }
            if (parent.type === 'ForNumericStatement' && parentKey === 'variable') {
                return { name: node.name, kind: 'variable', scope: 'local' };
            }
            if (parent.type === 'ForGenericStatement' && parentKey === 'variables') {
                return { name: node.name, kind: 'variable', scope: 'local' };
            }
            if (parent.type === 'FunctionDeclaration' && parentKey === 'parameters') {
                return { name: node.name, kind: 'variable', scope: 'local' };
            }
            if (parent.type === 'FunctionDeclaration' && parentKey === 'identifier') {
                return { name: node.name, kind: 'function', scope: parent.isLocal ? 'local' : 'global' };
            }

            return null;
        };

        const isPropertyIdentifier = (node, parent, parentKey) => {
            if (!isIdentifier(node) || !parent || typeof parent !== 'object') return false;
            // foo.bar -> 'bar' is not a variable reference
            if (parent.type === 'MemberExpression' && parentKey === 'identifier') return true;
            // { key = value } -> 'key' is not a variable reference
            if (parent.type === 'TableKeyString' && parentKey === 'key') return true;
            return false;
        };

        const walk = (node, visitor, parent = null, parentKey = null) => {
            if (!node || typeof node !== 'object') return;
            visitor(node, parent, parentKey);
            if (Array.isArray(node)) {
                // Preserve the *owner* node + key (e.g. AssignmentStatement.variables)
                // so visitors can correctly classify identifiers within those arrays.
                for (let i = 0; i < node.length; i++) walk(node[i], visitor, parent, parentKey);
                return;
            }
            for (const [key, value] of Object.entries(node)) {
                if (!value || typeof value !== 'object') continue;
                walk(value, visitor, node, key);
            }
        };

        walk(ast, (node, parent, parentKey) => {
            if (!isIdentifier(node)) return;

            const decl = getDeclarationInfo(node, parent, parentKey);
            if (decl) {
                const pos = toPos(node.loc);
                const existing = defsByName.get(decl.name);
                if (!existing || (pos && existing.pos && this.compareLuaPositions(pos, existing.pos) < 0)) {
                    defsByName.set(decl.name, { ...decl, pos });
                }
                return;
            }

            if (isPropertyIdentifier(node, parent, parentKey)) return;
            if (parent && typeof parent === 'object' && (parent.type === 'LabelStatement' || parent.type === 'GotoStatement')) return;

            refs.push({ name: node.name, pos: toPos(node.loc) });
        });

        const locals = new Map();
        const globals = new Map();
        for (const [name, def] of defsByName.entries()) {
            if (def.scope === 'local') locals.set(name, def);
            if (def.scope === 'global') globals.set(name, def);
        }

        return { defsByName, locals, globals, refs };
    }

    updateSessionLuaGlobalsFromCode(code, source) {
        const index = this.extractLuaSymbolIndex(code);
        if (!index) return;

        for (const [name, def] of index.globals.entries()) {
            if (!name) continue;
            const existing = this._sessionLuaGlobals.get(name);
            const next = { ...def, source: source || 'session' };
            if (!existing) {
                this._sessionLuaGlobals.set(name, next);
                continue;
            }
            if (def?.pos && existing?.pos && this.compareLuaPositions(def.pos, existing.pos) < 0) {
                this._sessionLuaGlobals.set(name, next);
            }
        }
    }

    getEditorContextKeyValue(editor, key) {
        const contextKeyService = editor?._contextKeyService;
        if (!contextKeyService || typeof contextKeyService.getContextKeyValue !== 'function') {
            return false;
        }
        return !!contextKeyService.getContextKeyValue(key);
    }

    registerLuaLanguage() {
        if (typeof monaco === 'undefined' || !monaco.languages) return;

        // Monaco's AMD build used here doesn't ship Lua out of the box. We register a minimal
        // Monarch tokenizer so Lua has syntax highlighting and basic language features.
        try {
            monaco.languages.register({ id: 'lua' });
        } catch {
            // It's fine if it's already registered.
        }

        const keywords = [
            'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'goto',
            'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while'
        ];

        monaco.languages.setMonarchTokensProvider('lua', {
            defaultToken: '',
            tokenPostfix: '.lua',
            keywords,
            tokenizer: {
                root: [
                    { include: '@whitespace' },

                    [/--\[\[/, { token: 'comment', next: '@comment' }],
                    [/--.*$/, 'comment'],

                    [/\[\[/, { token: 'string', next: '@longstring' }],
                    [/"/, { token: 'string.quote', next: '@string_dbl' }],
                    [/'/, { token: 'string.quote', next: '@string_sgl' }],

                    [/\d+(?:\.\d+)?(?:[eE][\-+]?\d+)?/, 'number'],

                    [/[{}\[\]()]/, '@brackets'],
                    [/[,.;:]/, 'delimiter'],
                    [/[=<>~]=|\.{2,3}|[+\-*\/^%#=<>]/, 'operator'],

                    [/[a-zA-Z_][\w_]*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }]
                ],

                whitespace: [
                    [/\s+/, 'white']
                ],

                comment: [
                    [/[^\]]+/, 'comment'],
                    [/\]\]/, { token: 'comment', next: '@pop' }],
                    [/\]/, 'comment']
                ],

                longstring: [
                    [/[^\]]+/, 'string'],
                    [/\]\]/, { token: 'string', next: '@pop' }],
                    [/\]/, 'string']
                ],

                string_dbl: [
                    [/[^\\"]+/, 'string'],
                    [/\\./, 'string.escape'],
                    [/"/, { token: 'string.quote', next: '@pop' }]
                ],

                string_sgl: [
                    [/[^\\']+/, 'string'],
                    [/\\./, 'string.escape'],
                    [/'/, { token: 'string.quote', next: '@pop' }]
                ]
            }
        });
    }

    initializeUI() {
        this.elements = {
            // Header
            toggleEditorBtn: document.getElementById('toggleEditorBtn'),
            scriptName: document.getElementById('scriptName'),
            
            // Toolbar
            runBtn: document.getElementById('runBtn'),
            uploadBtn: document.getElementById('uploadBtn'),
            newBtn: document.getElementById('newBtn'),
            openBtn: document.getElementById('openBtn'),
            boweryBtn: document.getElementById('boweryBtn'),
            saveBtn: document.getElementById('saveBtn'),
            renameBtn: document.getElementById('renameBtn'),
            horizontalLayoutBtn: document.getElementById('horizontalLayoutBtn'),
            verticalLayoutBtn: document.getElementById('verticalLayoutBtn'),
            swapPanesBtn: document.getElementById('swapPanesBtn'),
            
            // REPL controls
            connectionBtn: document.getElementById('replConnectionBtn'),
            replStatusIndicator: document.getElementById('replStatusIndicator'),
            replStatusText: document.getElementById('replStatusText'),
            
            // Editor/REPL
            editorContainer: document.getElementById('editor'),
            output: document.getElementById('output'),
            replInput: document.getElementById('replInput'),
            replEditorContainer: document.getElementById('replEditorContainer'),
            replInputContainer: document.querySelector('.repl-input-container'),
            toggleReplAutocomplete: document.getElementById('toggleReplAutocomplete'),
            resetBtn: document.getElementById('resetBtn'),
            helpBtn: document.getElementById('helpBtn'),
            clearBtn: document.getElementById('clearBtn'),
            
            // Stream monitors
            streamCanvas1: document.getElementById('streamCanvas1'),
            streamCanvas2: document.getElementById('streamCanvas2'),
            streamValue1: document.getElementById('streamValue1'),
            streamValue2: document.getElementById('streamValue2'),
            
            // Split pane
            toolbar: document.getElementById('toolbar'),
            splitContainer: document.getElementById('splitContainer'),
            editorPane: document.getElementById('editorPane'),
            splitHandle: document.getElementById('splitHandle'),
            replPane: document.getElementById('replPane'),
            
            // Script reference
            scriptReferenceBtn: document.getElementById('scriptReferenceBtn'),
            
            // File input
            fileInput: document.getElementById('fileInput'),
            
            // Modals
            browserWarning: document.getElementById('browserWarning'),
            closeWarning: document.getElementById('closeWarning'),
            boweryModal: document.getElementById('boweryModal'),
            closeBowery: document.getElementById('closeBowery'),
            boweryAction: document.getElementById('boweryAction'),
            bowerySearch: document.getElementById('bowerySearch'),
            boweryLoading: document.getElementById('boweryLoading'),
            boweryError: document.getElementById('boweryError'),
            boweryList: document.getElementById('boweryList'),
            bbboweryBtn: document.getElementById('bbboweryBtn'),
            bbboweryModal: document.getElementById('bbboweryModal'),
            closeBbbowery: document.getElementById('closeBbbowery'),
            bbboweryAction: document.getElementById('bbboweryAction'),
            bbbowerySearch: document.getElementById('bbbowerySearch'),
            bbboweryLoading: document.getElementById('bbboweryLoading'),
            bbboweryError: document.getElementById('bbboweryError'),
            bbboweryList: document.getElementById('bbboweryList')
        };

        // Initialize stream monitors
        this.streamData = {
            1: [],
            2: []
        };
        this.streamContexts = {
            1: this.elements.streamCanvas1.getContext('2d'),
            2: this.elements.streamCanvas2.getContext('2d')
        };
        
        // Start continuous animation for smooth scrolling
        this.startStreamAnimation();
        
        this.outputLine('//// welcome. connect to crow or blackbird to begin.');
    }

    checkBrowserSupport() {
        if (!('serial' in navigator)) {
            this.elements.browserWarning.style.display = 'flex';
            this.elements.connectionBtn.disabled = true;
            this.outputLine('ERROR: Web Serial API not supported in this browser.');
            this.outputLine('Please use Chrome, Edge, or Opera.');
        }
    }

    setupEventListeners() {
        // Editor toggle
        this.elements.toggleEditorBtn.addEventListener('change', (e) => this.toggleEditor(e.target.checked));

        // REPL autocomplete toggle
        this.elements.toggleReplAutocomplete.addEventListener('change', (e) => this.toggleReplAutocomplete(e.target.checked));

        // Connection
        this.elements.connectionBtn.addEventListener('click', () => this.toggleConnection());

        // Script actions
        this.elements.runBtn.addEventListener('click', () => this.runScript());
        this.elements.uploadBtn.addEventListener('click', () => this.uploadScript());
        this.elements.newBtn.addEventListener('click', () => this.newScript());
        this.elements.openBtn.addEventListener('click', () => this.openScript());
        this.elements.boweryBtn.addEventListener('click', () => this.openBoweryBrowser());
        this.elements.bbboweryBtn.addEventListener('click', () => this.openBbboweryBrowser());
        this.elements.saveBtn.addEventListener('click', () => this.saveScript());
        this.elements.renameBtn.addEventListener('click', () => this.renameScript());
        
        // Layout toggle buttons
        this.elements.horizontalLayoutBtn.addEventListener('click', () => this.setLayout('horizontal'));
        this.elements.verticalLayoutBtn.addEventListener('click', () => this.setLayout('vertical'));
        this.elements.swapPanesBtn.addEventListener('click', () => this.swapPanes());

        // File input
        this.elements.fileInput.addEventListener('change', (e) => this.handleFileSelect(e));

        // REPL input
        this.elements.replInput.addEventListener('keydown', (e) => this.handleReplInput(e));

        // REPL actions
        this.elements.resetBtn.addEventListener('click', () => this.resetCrow());
        this.elements.helpBtn.addEventListener('click', () => this.showHelp());
        this.elements.clearBtn.addEventListener('click', () => this.clearOutput());
        
        // Script reference
        this.elements.scriptReferenceBtn.addEventListener('click', () => {
            window.open('https://monome.org/docs/crow/reference', '_blank');
        });

        // Modals
        this.elements.closeWarning.addEventListener('click', () => {
            this.elements.browserWarning.style.display = 'none';
        });
        
        this.elements.closeBowery.addEventListener('click', () => {
            this.elements.boweryModal.style.display = 'none';
        });
        
        this.elements.closeBbbowery.addEventListener('click', () => {
            this.elements.bbboweryModal.style.display = 'none';
        });
        
        this.elements.bowerySearch.addEventListener('input', (e) => {
            this.filterBoweryScripts(e.target.value);
        });
        
        this.elements.bbbowerySearch.addEventListener('input', (e) => {
            this.filterBbboweryScripts(e.target.value);
        });

        // Crow callbacks
        this.crow.onDataReceived = (data) => this.handleCrowOutput(data);
        this.crow.onConnectionChange = (connected, error) => this.handleConnectionChange(connected, error);

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => this.handleKeyboardShortcut(e));

        // Drag and drop
        this.setupDragAndDrop();

        // Keep split panes filling the viewport on window resize
        window.addEventListener('resize', () => this.handleWindowResize());
    }

    isEditorVisible() {
        // Source of truth is the DOM (the toolbar and editor pane are shown/hidden together)
        return !this.elements.editorPane.classList.contains('hidden');
    }

    getCurrentSplitOrientation() {
        const container = this.elements.splitContainer;
        const isForcedVertical = container.classList.contains('force-vertical');
        const isForcedHorizontal = container.classList.contains('force-horizontal');
        const isResponsiveVertical = !isForcedHorizontal && window.innerWidth <= 768;
        return (isForcedVertical || isResponsiveVertical) ? 'vertical' : 'horizontal';
    }

    getSplitAvailableSize(orientation) {
        const containerRect = this.elements.splitContainer.getBoundingClientRect();
        const handleHidden = this.elements.splitHandle.classList.contains('hidden');
        const handleRect = handleHidden ? { width: 0, height: 0 } : this.elements.splitHandle.getBoundingClientRect();

        if (orientation === 'vertical') {
            return Math.max(0, containerRect.height - handleRect.height);
        }

        return Math.max(0, containerRect.width - handleRect.width);
    }

    captureSplitState() {
        if (this.elements.editorPane.classList.contains('hidden')) {
            this.splitState = null;
            return;
        }

        const orientation = this.getCurrentSplitOrientation();
        const available = this.getSplitAvailableSize(orientation);
        if (available <= 0) return;

        const replRect = this.elements.replPane.getBoundingClientRect();
        const replSize = orientation === 'vertical' ? replRect.height : replRect.width;
        const replFraction = Math.min(0.95, Math.max(0.05, replSize / available));

        this.splitState = { orientation, replFraction };
    }

    applySplitState() {
        // If editor is hidden, let the REPL take full space via CSS.
        if (this.elements.editorPane.classList.contains('hidden')) {
            return;
        }

        const orientation = this.getCurrentSplitOrientation();
        const available = this.getSplitAvailableSize(orientation);
        if (available <= 0) return;

        const replPane = this.elements.replPane;
        const editorPane = this.elements.editorPane;

        let replFraction = 0.5;
        if (this.splitState && this.splitState.orientation === orientation) {
            replFraction = this.splitState.replFraction;
        }

        // Match the drag constraints (200px) so we never create dead space.
        const minPaneSize = 200;
        let replTarget = Math.round(available * replFraction);
        let editorTarget = available - replTarget;

        if (replTarget < minPaneSize) {
            replTarget = minPaneSize;
            editorTarget = Math.max(minPaneSize, available - replTarget);
        }
        if (editorTarget < minPaneSize) {
            editorTarget = minPaneSize;
            replTarget = Math.max(minPaneSize, available - editorTarget);
        }

        replPane.style.flex = `0 0 ${replTarget}px`;
        editorPane.style.flex = `0 0 ${editorTarget}px`;

        this.splitState = {
            orientation,
            replFraction: available > 0 ? replTarget / available : 0.5
        };
    }

    handleWindowResize() {
        if (this._resizeRaf) {
            cancelAnimationFrame(this._resizeRaf);
        }

        this._resizeRaf = requestAnimationFrame(() => {
            this._resizeRaf = null;
            this.applySplitState();
            // Monaco is configured with automaticLayout, but an explicit layout keeps it snappy.
            if (this.editor) this.editor.layout();
            if (this.replEditor) this.replEditor.layout();
        });
    }

    initializeEditor() {
        // Ensure require is available
        if (typeof require === 'undefined') {
            console.error('RequireJS not loaded');
            return;
        }
        
        require.config({ paths: { vs: 'node_modules/monaco-editor/min/vs' } });
        
        require(['vs/editor/editor.main'], () => {
            this.registerLuaLanguage();

            // Configure Lua language settings
            monaco.languages.lua = monaco.languages.lua || {};
            
            // Set up Lua diagnostics options
            monaco.languages.setLanguageConfiguration('lua', {
                wordPattern: /(-?\d*\.\d\w*)|([^\`\~\!\@\#\%\^\&\*\(\)\-\=\+\[\{\]\}\\\|\;\:\'\"\,\.\<\>\/\?\s]+)/g,
                brackets: [
                    ['{', '}'],
                    ['[', ']'],
                    ['(', ')']
                ],
                autoClosingPairs: [
                    { open: '{', close: '}' },
                    { open: '[', close: ']' },
                    { open: '(', close: ')' },
                    { open: '"', close: '"' },
                    { open: "'", close: "'" }
                ],
                surroundingPairs: [
                    { open: '{', close: '}' },
                    { open: '[', close: ']' },
                    { open: '(', close: ')' },
                    { open: '"', close: '"' },
                    { open: "'", close: "'" }
                ]
            });

            // Register crow API autocomplete provider
            this.registerCrowCompletions();

            this.editor = monaco.editor.create(this.elements.editorContainer, {
                value: '-- crow script\n\nfunction init()\n  print("hello crow")\nend\n',
                language: 'lua',
                theme: 'vs-dark',
                fontSize: 14,
                fontFamily: 'monospace',
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                automaticLayout: true,
                lineNumbers: 'on',
                folding: true,
                renderWhitespace: 'selection',
                tabSize: 2,
                matchBrackets: 'always',
                bracketPairColorization: { enabled: true }
            });

            // Track modifications
            this.editor.onDidChangeModelContent(() => {
                if (this._suppressEditorChange) {
                    this.validateLuaSyntax();
                    return;
                }
                this.setModified(true);
                this.validateLuaSyntax();
            });

            // Add context menu action to send selection to crow
            this.editor.addAction({
                id: 'send-to-crow',
                label: 'Send Selection to Crow',
                contextMenuGroupId: 'navigation',
                contextMenuOrder: 1.5,
                keybindings: [
                    monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter
                ],
                run: (ed) => {
                    const selection = ed.getSelection();
                    const selectedText = ed.getModel().getValueInRange(selection);
                    
                    if (selectedText.trim()) {
                        this.sendToCrow(selectedText);
                    } else {
                        // If no selection, send current line
                        const lineNumber = selection.startLineNumber;
                        const lineContent = ed.getModel().getLineContent(lineNumber);
                        if (lineContent.trim()) {
                            this.sendToCrow(lineContent);
                        }
                    }
                }
            });

            // Initial validation
            this.validateLuaSyntax();
            
            // Initialize REPL editor after main editor is ready
            this.initializeReplEditor();
        });
    }

    initializeReplEditor() {
        // Create Monaco editor for REPL input
        this.replEditor = monaco.editor.create(this.elements.replEditorContainer, {
            value: '',
            language: 'lua',
            theme: 'vs-dark',
            fontSize: 14,
            fontFamily: 'monospace',
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            lineNumbers: 'off',
            folding: false,
            renderWhitespace: 'none',
            tabSize: 2,
            matchBrackets: 'never',
            scrollbar: {
                vertical: 'auto',
                horizontal: 'auto',
                verticalScrollbarSize: 8,
                horizontalScrollbarSize: 8
            },
            wordWrap: 'on',
            lineDecorationsWidth: 0,
            lineNumbersMinChars: 0,
            glyphMargin: false,
            overviewRulerLanes: 0,
            hideCursorInOverviewRuler: true,
            overviewRulerBorder: false,
            suggest: {
                showKeywords: true,
                showSnippets: true,
                selectionMode: 'never',  // Don't pre-select suggestions
                filterGraceful: false,
                snippetsPreventQuickSuggestions: false
            },
            quickSuggestions: {
                other: true,
                comments: false,
                strings: false
            },
            acceptSuggestionOnEnter: 'on',
            suggestOnTriggerCharacters: true
        });

        // Add placeholder text
        this.replPlaceholder = {
            domNode: null,
            getId: function() { return 'repl.placeholder'; },
            getDomNode: function() {
                if (!this.domNode) {
                    this.domNode = document.createElement('div');
                    this.domNode.style.color = '#8b8b8b';
                    this.domNode.style.fontFamily = 'monospace';
                    this.domNode.style.fontSize = '14px';
                    this.domNode.style.pointerEvents = 'none';
                    this.domNode.style.whiteSpace = 'nowrap';
                    this.domNode.style.marginTop = '4px';
                    this.domNode.style.marginLeft = '4px';
                    this.domNode.textContent = 'send word to the bird';
                }
                return this.domNode;
            },
            getPosition: function() {
                return {
                    position: { lineNumber: 1, column: 1 },
                    preference: [monaco.editor.ContentWidgetPositionPreference.EXACT]
                };
            }
        };

        // Show/hide placeholder based on content
        const updatePlaceholder = () => {
            if (this.replEditor.getValue() === '') {
                this.replEditor.addContentWidget(this.replPlaceholder);
            } else {
                this.replEditor.removeContentWidget(this.replPlaceholder);
            }
        };

        updatePlaceholder();
        this.replEditor.onDidChangeModelContent(updatePlaceholder);

        // Handle keyboard events with explicit focus checking
        this.replEditor.onKeyDown((e) => {
            // Only process if autocomplete is enabled and this editor has focus
            if (!this.replAutocompleteEnabled || !this.replEditor.hasTextFocus()) {
                return;
            }

            const keyCode = e.keyCode;

            // Prefer Monaco context keys over DOM class probing. This avoids accidental coupling
            // to internal widget markup and works reliably with multiple editors on the page.
            const isSuggestVisible = this.getEditorContextKeyValue(this.replEditor, 'suggestWidgetVisible');
            const hasFocusedSuggestion = this.getEditorContextKeyValue(this.replEditor, 'suggestWidgetHasFocusedSuggestion');
            
            // Handle Enter key
            if (keyCode === monaco.KeyCode.Enter && !e.shiftKey) {
                // If suggest is visible and a suggestion is focused, let Monaco accept it.
                // If suggest is visible but nothing is focused, treat Enter as "send".
                if (isSuggestVisible && hasFocusedSuggestion) {
                    return;
                }
                // Otherwise, send the command
                const code = this.replEditor.getValue().trim();
                if (code) {
                    e.preventDefault();
                    e.stopPropagation();
                    if (isSuggestVisible && !hasFocusedSuggestion) {
                        this.replEditor.trigger('keyboard', 'hideSuggestWidget', null);
                    }
                    this.sendReplCommand(code);
                }
                return;
            }
            // Shift+Enter always creates a new line (default behavior, don't prevent)
            
            // Handle Up/Down arrows - only navigate history when suggestion widget is NOT visible
            // When suggestion widget IS visible, let Monaco handle arrow keys for navigation
            if (keyCode === monaco.KeyCode.UpArrow && !isSuggestVisible) {
                e.preventDefault();
                e.stopPropagation();
                this.navigateReplHistory('up');
                return;
            }
            
            if (keyCode === monaco.KeyCode.DownArrow && !isSuggestVisible) {
                e.preventDefault();
                e.stopPropagation();
                this.navigateReplHistory('down');
                return;
            }
            
            // If we get here and suggest is visible, let Monaco handle the event
        });

        // Validate syntax as user types
        this.replEditor.onDidChangeModelContent(() => {
            if (this.replAutocompleteEnabled) {
                this.validateReplSyntax();
                // Reset history index when user modifies content (but not during history navigation)
                if (this.historyIndex !== -1 && !this.isNavigatingHistory) {
                    this.historyIndex = -1;
                }
            }
        });

        // Start with autocomplete enabled
        this.toggleReplAutocomplete(true);
    }

    validateReplSyntax() {
        if (!this.replEditor) return;
        
        const model = this.replEditor.getModel();
        const code = model.getValue();
        
        if (!code.trim()) {
            monaco.editor.setModelMarkers(model, 'lua', []);
            return;
        }

        try {
            luaparse.parse(code, { 
                wait: false,
                comments: false,
                scope: false,
                locations: true,
                ranges: true
            });

            const markers = [];
            const KNOWN_GLOBALS = new Set([
                // Lua built-ins (5.3/5.4-ish)
                '_G', '_VERSION',
                'assert', 'collectgarbage', 'dofile', 'error', 'getmetatable', 'ipairs', 'load', 'loadfile',
                'next', 'pairs', 'pcall', 'print', 'rawequal', 'rawget', 'rawlen', 'rawset', 'require',
                'select', 'setmetatable', 'tonumber', 'tostring', 'type', 'xpcall',
                'coroutine', 'string', 'table', 'math', 'utf8', 'package',
                'io', 'os', 'debug',

                // crow globals / commonly used APIs
                'crow', 'input', 'output', 'metro', 'clock', 'delay', 'timeline', 'hotswap', 'ii', 'public', 'cal',
                'tell', 'quote', 'unique_id', 'time', 'cputime', 'justvolts', 'just12', 'hztovolts',
                'dyn', 'to', 'loop', 'held', 'lock', 'times', 'asl', 'sequins', 's',

                // host extensions / blackbird
                'tab', 'bb'
            ]);
            for (const name of this._sessionLuaGlobals.keys()) KNOWN_GLOBALS.add(name);

            const index = this.extractLuaSymbolIndex(code);
            if (index) {
                const MAX_UNDEFINED_MARKERS = 50;
                const emitted = new Set();
                for (const ref of index.refs) {
                    if (markers.length >= MAX_UNDEFINED_MARKERS) break;
                    const name = ref.name;
                    if (KNOWN_GLOBALS.has(name)) continue;

                    const def = index.defsByName.get(name) || this._sessionLuaGlobals.get(name);
                    if (def?.pos && ref.pos && this.compareLuaPositions(def.pos, ref.pos) <= 0) continue;

                    const key = `${name}@${ref.pos?.line || 0}:${ref.pos?.column || 0}`;
                    if (emitted.has(key)) continue;
                    emitted.add(key);

                    if (!ref.pos?.line || !ref.pos?.column) continue;
                    markers.push({
                        severity: monaco.MarkerSeverity.Warning,
                        startLineNumber: ref.pos.line,
                        startColumn: ref.pos.column,
                        endLineNumber: ref.pos.line,
                        endColumn: ref.pos.column + name.length,
                        message: `Possibly undefined name: ${name}`
                    });
                }
            }

            monaco.editor.setModelMarkers(model, 'lua', markers);
        } catch (error) {
            if (error.line && error.column) {
                const markers = [{
                    severity: monaco.MarkerSeverity.Error,
                    startLineNumber: error.line,
                    startColumn: error.column,
                    endLineNumber: error.line,
                    endColumn: error.column + 1,
                    message: error.message
                }];
                monaco.editor.setModelMarkers(model, 'lua', markers);
            }
        }
    }

    navigateReplHistory(direction) {
        if (direction === 'up') {
            if (this.commandHistory.length === 0) return;
            
            if (this.historyIndex === -1) {
                this.currentInput = this.replEditor.getValue();
            }
            
            if (this.historyIndex < this.commandHistory.length - 1) {
                this.historyIndex++;
                this.isNavigatingHistory = true;
                this.replEditor.setValue(this.commandHistory[this.commandHistory.length - 1 - this.historyIndex]);
                this.isNavigatingHistory = false;
            }
        } else if (direction === 'down') {
            if (this.historyIndex === -1) return;
            
            this.historyIndex--;
            this.isNavigatingHistory = true;
            if (this.historyIndex === -1) {
                this.replEditor.setValue(this.currentInput);
            } else {
                this.replEditor.setValue(this.commandHistory[this.commandHistory.length - 1 - this.historyIndex]);
            }
            this.isNavigatingHistory = false;
        }
    }

    async sendReplCommand(code) {
        // Output the sent command BEFORE sending to ensure it appears first
        this.outputLine(`>> ${code}`);

        // Track globals defined in the REPL so they can be suggested later.
        this.updateSessionLuaGlobalsFromCode(code, 'repl');
        
        // Add to command history (avoid duplicates of the last command)
        // This happens regardless of connection status
        if (this.commandHistory.length === 0 || this.commandHistory[this.commandHistory.length - 1] !== code) {
            this.commandHistory.push(code);
        }
        
        if (!this.crow.isConnected) {
            this.outputLine('crow is not connected');
            this.replEditor.setValue('');
            // Reset history navigation
            this.historyIndex = -1;
            this.currentInput = '';
            return;
        }
        
        try {
            const lines = code.split('\n');
            for (const line of lines) {
                await this.crow.writeLine(line);
                await this.delay(1);
            }
            
            // Reset history navigation
            this.historyIndex = -1;
            this.currentInput = '';
            this.replEditor.setValue('');
        } catch (error) {
            this.outputLine(`Error: ${error.message}`);
        }
    }

    toggleReplAutocomplete(enabled) {
        this.replAutocompleteEnabled = enabled;
        
        if (enabled) {
            // Show Monaco editor, hide textarea
            this.elements.replEditorContainer.style.display = 'block';
            this.elements.replInput.style.display = 'none';
            this.elements.replInputContainer.classList.add('editor-mode');
            this.elements.replInputContainer.classList.remove('autocomplete-disabled');
            
            // Transfer any content from textarea to editor
            const textareaValue = this.elements.replInput.value;
            if (textareaValue && !this.replEditor.getValue()) {
                this.replEditor.setValue(textareaValue);
            }
            
            // Focus the editor
            this.replEditor.focus();
        } else {
            // Show textarea, hide Monaco editor
            this.elements.replEditorContainer.style.display = 'none';
            this.elements.replInput.style.display = 'block';
            this.elements.replInputContainer.classList.remove('editor-mode');
            this.elements.replInputContainer.classList.add('autocomplete-disabled');
            
            // Transfer any content from editor to textarea
            const editorValue = this.replEditor.getValue();
            if (editorValue && !this.elements.replInput.value) {
                this.elements.replInput.value = editorValue;
            }
            
            // Focus the textarea
            this.elements.replInput.focus();
        }
    }

    registerCrowCompletions() {
        if (this._crowCompletionsRegistered) return;
        this._crowCompletionsRegistered = true;

        const app = this;

        const parseCache = new Map();
        const getModelCacheKey = (model) => model?.uri?.toString?.() || 'unknown';

        const safeLuaparse = (code) => app.extractLuaSymbolIndex(code);

        const getSymbolSuggestions = (model) => {
            const key = getModelCacheKey(model);
            const versionId = model.getVersionId();
            const cached = parseCache.get(key);
            if (cached?.versionId === versionId) return cached.suggestions;

            const code = model.getValue();
            const index = safeLuaparse(code);
            if (!index) {
                const empty = [];
                parseCache.set(key, { versionId, suggestions: empty });
                return empty;
            }
            const suggestions = [];
            for (const [name, def] of index.defsByName.entries()) {
                const kind = def.kind;
                const scope = def.scope;
                const pos = def.pos;
                const location = pos?.line ? `Defined at line ${pos.line}:${pos.column}` : 'User-defined symbol';
                suggestions.push({
                    label: name,
                    kind: kind === 'function' ? monaco.languages.CompletionItemKind.Function : monaco.languages.CompletionItemKind.Variable,
                    insertText: name,
                    sortText: `1_${name}`,
                    detail: `User ${kind} (${scope})`,
                    documentation: location
                });
            }

            for (const [name, def] of app._sessionLuaGlobals.entries()) {
                if (!name || index.defsByName.has(name)) continue;
                const pos = def?.pos;
                const location = pos?.line ? `Defined at line ${pos.line}:${pos.column} (${def.source || 'session'})` : 'Defined earlier in this session';
                suggestions.push({
                    label: name,
                    kind: monaco.languages.CompletionItemKind.Variable,
                    insertText: name,
                    sortText: `2_${name}`,
                    detail: 'Session global',
                    documentation: location
                });
            }

            parseCache.set(key, { versionId, suggestions, index });
            return suggestions;
        };

        const baseSuggestions = [
            // Lua basics
            {
                label: 'print',
                kind: monaco.languages.CompletionItemKind.Function,
                insertText: 'print(${1:value})',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'Print values to output'
            },
            {
                label: 'tab.print',
                kind: monaco.languages.CompletionItemKind.Function,
                insertText: 'tab.print(${1:table})',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'Print table contents (crow-specific)'
            },

            // Input API
            {
                label: 'input[n].volts',
                kind: monaco.languages.CompletionItemKind.Property,
                insertText: 'input[${1:n}].volts',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'Get current voltage on input n'
            },
            {
                label: 'input[n].query',
                kind: monaco.languages.CompletionItemKind.Method,
                insertText: 'input[${1:n}].query',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: "Send input n's value to host"
            },
            {
                label: 'input[n].mode',
                kind: monaco.languages.CompletionItemKind.Method,
                insertText: "input[${1:n}].mode = '${2:stream}'",
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: "Set input mode: 'none', 'stream', 'change', 'window', 'scale', 'volume', 'peak', 'freq', 'clock'"
            },

            // Output API
            {
                label: 'output[n].volts',
                kind: monaco.languages.CompletionItemKind.Property,
                insertText: 'output[${1:n}].volts = ${2:0}',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'Set output n to specified voltage'
            },
            {
                label: 'output[n].slew',
                kind: monaco.languages.CompletionItemKind.Property,
                insertText: 'output[${1:n}].slew = ${2:0.1}',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'Set slew time in seconds for output n'
            },
            {
                label: 'output[n].shape',
                kind: monaco.languages.CompletionItemKind.Property,
                insertText: "output[${1:n}].shape = '${2:linear}'",
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: "Set slew shape: 'linear', 'sine', 'logarithmic', 'exponential', 'now', 'wait', 'over', 'under', 'rebound'"
            },
            {
                label: 'output[n].scale',
                kind: monaco.languages.CompletionItemKind.Method,
                insertText: 'output[${1:n}].scale({${2:0,2,4,5,7,9,11}})',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'Quantize output to a scale'
            },
            {
                label: 'output[n].action',
                kind: monaco.languages.CompletionItemKind.Property,
                insertText: 'output[${1:n}].action = ${2:lfo()}',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'Set output action (lfo, pulse, ar, adsr, etc.)'
            },

            // Actions
            {
                label: 'lfo',
                kind: monaco.languages.CompletionItemKind.Function,
                insertText: 'lfo(${1:time}, ${2:level}, ${3:shape})',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'Low frequency oscillator action'
            },
            {
                label: 'pulse',
                kind: monaco.languages.CompletionItemKind.Function,
                insertText: 'pulse(${1:time}, ${2:level}, ${3:polarity})',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'Trigger/gate generator action'
            },
            {
                label: 'ar',
                kind: monaco.languages.CompletionItemKind.Function,
                insertText: 'ar(${1:attack}, ${2:release}, ${3:level}, ${4:shape})',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'Attack-release envelope'
            },
            {
                label: 'adsr',
                kind: monaco.languages.CompletionItemKind.Function,
                insertText: 'adsr(${1:attack}, ${2:decay}, ${3:sustain}, ${4:release}, ${5:shape})',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'ADSR envelope'
            },

            // Metro
            {
                label: 'metro[n].event',
                kind: monaco.languages.CompletionItemKind.Property,
                insertText: 'metro[${1:n}].event = function(c) ${2:print(c)} end',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'Set event handler for metro n'
            },
            {
                label: 'metro[n].time',
                kind: monaco.languages.CompletionItemKind.Property,
                insertText: 'metro[${1:n}].time = ${2:1.0}',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'Set time interval in seconds for metro n'
            },
            {
                label: 'metro[n]:start',
                kind: monaco.languages.CompletionItemKind.Method,
                insertText: 'metro[${1:n}]:start()',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'Start metro n'
            },
            {
                label: 'metro[n]:stop',
                kind: monaco.languages.CompletionItemKind.Method,
                insertText: 'metro[${1:n}]:stop()',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'Stop metro n'
            },

            // Clock
            {
                label: 'clock.tempo',
                kind: monaco.languages.CompletionItemKind.Property,
                insertText: 'clock.tempo = ${1:120}',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'Set clock tempo in BPM'
            },
            {
                label: 'clock.run',
                kind: monaco.languages.CompletionItemKind.Function,
                insertText: 'clock.run(${1:func})',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'Run a function in a coroutine'
            },
            {
                label: 'clock.sleep',
                kind: monaco.languages.CompletionItemKind.Function,
                insertText: 'clock.sleep(${1:seconds})',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'Sleep for specified time in seconds'
            },
            {
                label: 'clock.sync',
                kind: monaco.languages.CompletionItemKind.Function,
                insertText: 'clock.sync(${1:beats})',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'Sleep until next sync at specified beat interval'
            },

            // Sequins
            {
                label: 'sequins',
                kind: monaco.languages.CompletionItemKind.Function,
                insertText: 'sequins{${1:1,2,3}}',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'Create a sequins sequencer'
            },

            // ASL
            {
                label: 'to',
                kind: monaco.languages.CompletionItemKind.Function,
                insertText: 'to(${1:dest}, ${2:time}, ${3:shape})',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'ASL primitive: move to destination over time'
            },
            {
                label: 'loop',
                kind: monaco.languages.CompletionItemKind.Function,
                insertText: 'loop{${1:}}',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'ASL: loop the sequence'
            },

            // ii
            {
                label: 'ii.jf.play_note',
                kind: monaco.languages.CompletionItemKind.Method,
                insertText: 'ii.jf.play_note(${1:volts}, ${2:level})',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'Just Friends: play a note at specified voltage and level'
            },
            {
                label: 'ii.jf.trigger',
                kind: monaco.languages.CompletionItemKind.Method,
                insertText: 'ii.jf.trigger(${1:channel}, ${2:state})',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'Just Friends: set trigger state for channel'
            },

            // Utilities
            {
                label: 'math.random',
                kind: monaco.languages.CompletionItemKind.Function,
                insertText: 'math.random(${1:})',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'Generate a random number (hardware-based)'
            },
            {
                label: 'public',
                kind: monaco.languages.CompletionItemKind.Function,
                insertText: 'public{${1:name} = ${2:value}}',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'Create a public variable accessible from host'
            },
            {
                label: 'public{...}:range',
                kind: monaco.languages.CompletionItemKind.Method,
                insertText: 'public{${1:name} = ${2:0}}:range(${3:-5}, ${4:10})',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: "Declare a numeric range for a public variable (values clamp to bounds)"
            },
            {
                label: 'public{...}:type',
                kind: monaco.languages.CompletionItemKind.Method,
                insertText: "public{${1:name} = ${2:0}}:type('${3:int}')",
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: "Hint public variable type to the host (e.g. 'int', 'exp', 'slider', '@', '@int')"
            },
            {
                label: 'public{...}:options',
                kind: monaco.languages.CompletionItemKind.Method,
                insertText: "public{${1:name} = '${2:+}'}:options{'+', '-', '*', '/'}",
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'Declare enumerated string options for a public variable'
            },
            {
                label: 'public{...}:action',
                kind: monaco.languages.CompletionItemKind.Method,
                insertText: 'public{${1:name} = ${2:0}}:action(${3:on_change})',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'Call a function whenever the public variable is updated from the host'
            },

            // ASL dynamics helpers
            {
                label: 'dyn{...}',
                kind: monaco.languages.CompletionItemKind.Function,
                insertText: 'dyn{${1:name}=${2:1}}',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'ASL dynamic variable (use with output[n].dyn.name = value)'
            },
            {
                label: 'dyn{...}:step',
                kind: monaco.languages.CompletionItemKind.Method,
                insertText: 'dyn{${1:name}=${2:0.1}}:step(${3:0.1})',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'ASL dyn mutation: add/subtract on each access'
            },
            {
                label: 'dyn{...}:mul',
                kind: monaco.languages.CompletionItemKind.Method,
                insertText: 'dyn{${1:name}=${2:1}}:mul(${3:1.1})',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'ASL dyn mutation: multiply on each access'
            },
            {
                label: 'dyn{...}:wrap',
                kind: monaco.languages.CompletionItemKind.Method,
                insertText: 'dyn{${1:name}=${2:0.1}}:wrap(${3:0.1}, ${4:5})',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'ASL dyn mutation: wrap value into a range'
            },

            // Blackbird (bb namespace) - Workshop Computer specific
            {
                label: 'bb.knob.main',
                kind: monaco.languages.CompletionItemKind.Property,
                insertText: 'bb.knob.main',
                documentation: 'Blackbird: Read main knob value (0.0 to 1.0)'
            },
            {
                label: 'bb.knob.x',
                kind: monaco.languages.CompletionItemKind.Property,
                insertText: 'bb.knob.x',
                documentation: 'Blackbird: Read X knob value (0.0 to 1.0)'
            },
            {
                label: 'bb.knob.y',
                kind: monaco.languages.CompletionItemKind.Property,
                insertText: 'bb.knob.y',
                documentation: 'Blackbird: Read Y knob value (0.0 to 1.0)'
            },
            {
                label: 'bb.switch.position',
                kind: monaco.languages.CompletionItemKind.Property,
                insertText: 'bb.switch.position',
                documentation: "Blackbird: Read 3-position switch position ('down', 'middle', 'up')"
            },
            {
                label: 'bb.switch.change',
                kind: monaco.languages.CompletionItemKind.Property,
                insertText: "bb.switch.change = function(position)\n  ${1:print(position)}\nend",
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: "Blackbird: Callback when switch moves (position is 'down'|'middle'|'up')"
            },
            {
                label: 'bb.pulsein[n].mode',
                kind: monaco.languages.CompletionItemKind.Property,
                insertText: "bb.pulsein[${1:n}].mode = '${2:change}'",
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: "Blackbird: Set pulse input mode ('change' or 'none')"
            },
            {
                label: 'bb.pulsein[n].direction',
                kind: monaco.languages.CompletionItemKind.Property,
                insertText: "bb.pulsein[${1:n}].direction = '${2:rising}'",
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: "Blackbird: Set pulse input direction ('rising', 'falling', or 'both')"
            },
            {
                label: 'bb.pulsein[n].change',
                kind: monaco.languages.CompletionItemKind.Property,
                insertText: 'bb.pulsein[${1:n}].change = function(state) ${2:print(state)} end',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'Blackbird: Callback fired on pulse edges when mode is change'
            },
            {
                label: 'bb.pulsein[n].state',
                kind: monaco.languages.CompletionItemKind.Property,
                insertText: 'bb.pulsein[${1:n}].state',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'Blackbird: Read current boolean pulse input state (read-only)'
            },
            {
                label: 'bb.pulsein[n]{...}',
                kind: monaco.languages.CompletionItemKind.Function,
                insertText: "bb.pulsein[${1:n}]{ mode = '${2:change}', direction = '${3:both}' }",
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'Blackbird: crow-style table call configuration for pulsein'
            },
            {
                label: 'bb.pulseout[n]:clock',
                kind: monaco.languages.CompletionItemKind.Method,
                insertText: 'bb.pulseout[${1:n}]:clock(${2:1})',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'Blackbird: Set pulse output to clock mode with division'
            },
            {
                label: "bb.pulseout[n]:clock('off')",
                kind: monaco.languages.CompletionItemKind.Method,
                insertText: "bb.pulseout[${1:n}]:clock('off')",
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'Blackbird: Stop clocked pulses'
            },
            {
                label: 'bb.pulseout[n]:high',
                kind: monaco.languages.CompletionItemKind.Method,
                insertText: 'bb.pulseout[${1:n}]:high()',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'Blackbird: Set pulse output high'
            },
            {
                label: 'bb.pulseout[n]:low',
                kind: monaco.languages.CompletionItemKind.Method,
                insertText: 'bb.pulseout[${1:n}]:low()',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'Blackbird: Set pulse output low'
            },
            {
                label: 'bb.pulseout[n].action',
                kind: monaco.languages.CompletionItemKind.Property,
                insertText: 'bb.pulseout[${1:n}].action = pulse(${2:0.010})',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'Blackbird: Set action executed by :clock() (pulse width in seconds)'
            },
            {
                label: 'bb.pulseout[n].state',
                kind: monaco.languages.CompletionItemKind.Property,
                insertText: 'bb.pulseout[${1:n}].state',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'Blackbird: Read current pulse output state (true=high, false=low)'
            },
            {
                label: 'bb.audioin[n].volts',
                kind: monaco.languages.CompletionItemKind.Property,
                insertText: 'bb.audioin[${1:n}].volts',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'Blackbird: Read audio input voltage'
            },
            {
                label: 'bb.noise',
                kind: monaco.languages.CompletionItemKind.Function,
                insertText: 'bb.noise(${1:1.0})',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'Blackbird: Generate audio-rate noise action (gain 0.0-1.0)'
            },
            {
                label: 'bb.asap',
                kind: monaco.languages.CompletionItemKind.Property,
                insertText: 'bb.asap = function() ${1:-- fast loop} end',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'Blackbird: Run code as fast as possible (use carefully)'
            },
            {
                label: 'bb.priority',
                kind: monaco.languages.CompletionItemKind.Function,
                insertText: "bb.priority('${1:timing}')",
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: "Blackbird: Set processing priority ('timing', 'balanced', or 'accuracy')"
            }
        ];

        const docsByLabel = new Map();
        for (const item of baseSuggestions) {
            if (item?.label && item?.documentation) {
                docsByLabel.set(item.label, item.documentation);
            }
        }

        const getHoverExpressionAtPosition = (model, position) => {
            const line = model.getLineContent(position.lineNumber);
            const idx = Math.max(0, Math.min(line.length, position.column - 1));
            const isExprChar = (ch) => /[a-zA-Z0-9_\.\[\]:]/.test(ch);

            let start = idx;
            while (start > 0 && isExprChar(line[start - 1])) start--;
            let end = idx;
            while (end < line.length && isExprChar(line[end])) end++;
            const raw = line.substring(start, end).trim();
            if (!raw) return null;
            return raw.replace(/\[\s*\d+\s*\]/g, '[n]');
        };

        monaco.languages.registerCompletionItemProvider('lua', {
            provideCompletionItems: (model, position) => {
                // Get the text before the cursor to detect if user has typed "^" or "^^"
                const lineContent = model.getLineContent(position.lineNumber);
                const textBeforeCursor = lineContent.substring(0, position.column - 1);
                const match = textBeforeCursor.match(/\^*$/);
                const caretCount = match ? match[0].length : 0;
                const includeCrowCommands = caretCount > 0;

                // Create a range that will replace any existing "^" characters
                const caretReplaceRange = new monaco.Range(
                    position.lineNumber,
                    position.column - caretCount,
                    position.lineNumber,
                    position.column
                );

                const wordUntil = model.getWordUntilPosition(position);
                const wordRange = new monaco.Range(
                    position.lineNumber,
                    wordUntil.startColumn,
                    position.lineNumber,
                    wordUntil.endColumn
                );

                const crowControlSuggestions = [
                    {
                        label: '^^i',
                        kind: monaco.languages.CompletionItemKind.Keyword,
                        insertText: '^^i',
                        filterText: '^^i',
                        sortText: '0^^i',
                        range: caretReplaceRange,
                        documentation: 'Print identity'
                    },
                    {
                        label: '^^v',
                        kind: monaco.languages.CompletionItemKind.Keyword,
                        insertText: '^^v',
                        filterText: '^^v',
                        sortText: '0^^v',
                        range: caretReplaceRange,
                        documentation: 'Print version'
                    },
                    {
                        label: '^^p',
                        kind: monaco.languages.CompletionItemKind.Keyword,
                        insertText: '^^p',
                        filterText: '^^p',
                        sortText: '0^^p',
                        range: caretReplaceRange,
                        documentation: 'Print current userscript'
                    },
                    {
                        label: '^^r',
                        kind: monaco.languages.CompletionItemKind.Keyword,
                        insertText: '^^r',
                        filterText: '^^r',
                        sortText: '0^^r',
                        range: caretReplaceRange,
                        documentation: 'Restart crow'
                    },
                    {
                        label: '^^k',
                        kind: monaco.languages.CompletionItemKind.Keyword,
                        insertText: '^^k',
                        filterText: '^^k',
                        sortText: '0^^k',
                        range: caretReplaceRange,
                        documentation: 'Kill running script'
                    },
                    {
                        label: '^^c',
                        kind: monaco.languages.CompletionItemKind.Keyword,
                        insertText: '^^c',
                        filterText: '^^c',
                        sortText: '0^^c',
                        range: caretReplaceRange,
                        documentation: 'Clear userscript from flash'
                    },
                    {
                        label: '^^b',
                        kind: monaco.languages.CompletionItemKind.Keyword,
                        insertText: '^^b',
                        filterText: '^^b',
                        sortText: '0^^b',
                        range: caretReplaceRange,
                        documentation: 'Enter bootloader mode'
                    }
                ];

                for (const item of crowControlSuggestions) {
                    if (item?.label && item?.documentation) docsByLabel.set(item.label, item.documentation);
                }

                // If the user is typing a caret command, only show caret commands.
                // This prevents ^^ items from appearing in normal Lua editing.
                if (includeCrowCommands) {
                    return { suggestions: crowControlSuggestions };
                }

                // Add symbol-based completions (locals/functions) for the current model.
                const symbolSuggestions = getSymbolSuggestions(model);

                const memberSuggestions = [];
                const before = textBeforeCursor;
                const addMember = (label, documentation, kind = monaco.languages.CompletionItemKind.Property) => {
                    memberSuggestions.push({
                        label,
                        kind,
                        insertText: label,
                        range: wordRange,
                        sortText: `0_${label}`,
                        documentation
                    });
                };

                let isMemberContext = false;

                // Blackbird member contexts
                if (/\bbb\.(\w*)$/.test(before)) {
                    isMemberContext = true;
                    addMember('knob', 'Blackbird: knobs namespace');
                    addMember('switch', 'Blackbird: switch namespace');
                    addMember('pulsein', 'Blackbird: pulse input namespace');
                    addMember('pulseout', 'Blackbird: pulse output namespace');
                    addMember('audioin', 'Blackbird: audio input namespace');
                    addMember('noise', 'Blackbird: noise action');
                    addMember('asap', 'Blackbird: ASAP function (fast loop)');
                    addMember('priority', 'Blackbird: processing priority');
                } else if (/\bbb\.knob\.(\w*)$/.test(before)) {
                    isMemberContext = true;
                    addMember('main', 'Main knob (0.0-1.0)');
                    addMember('x', 'X knob (0.0-1.0)');
                    addMember('y', 'Y knob (0.0-1.0)');
                } else if (/\bbb\.switch\.(\w*)$/.test(before)) {
                    isMemberContext = true;
                    addMember('position', "Switch position: 'down'|'middle'|'up'");
                    addMember('change', "Callback: function(position) ... end", monaco.languages.CompletionItemKind.Property);
                } else if (/\bbb\.pulsein\[\s*\d+\s*\]\.(\w*)$/.test(before)) {
                    isMemberContext = true;
                    addMember('mode', "'none'|'change'");
                    addMember('direction', "'both'|'rising'|'falling'");
                    addMember('state', 'Read-only boolean current state');
                    addMember('change', 'Callback fired on edges');
                } else if (/\bbb\.pulseout\[\s*\d+\s*\]\.(\w*)$/.test(before)) {
                    isMemberContext = true;
                    addMember('action', 'Action executed by :clock()');
                    addMember('state', 'Read-only boolean current state');
                } else if (/\bbb\.pulseout\[\s*\d+\s*\]:(\w*)$/.test(before)) {
                    isMemberContext = true;
                    addMember('clock', 'Start/stop clocked pulses');
                    addMember('high', 'Set high indefinitely');
                    addMember('low', 'Set low indefinitely');
                }

                // crow member contexts (lightweight)
                if (!isMemberContext && /\binput\[\s*\d+\s*\]\.(\w*)$/.test(before)) {
                    isMemberContext = true;
                    addMember('volts', 'Current input voltage');
                    addMember('query', 'Send current value to host');
                    addMember('mode', 'Configure input mode');
                    addMember('stream', 'Assign stream callback');
                    addMember('change', 'Assign change callback');
                } else if (!isMemberContext && /\boutput\[\s*\d+\s*\]\.(\w*)$/.test(before)) {
                    isMemberContext = true;
                    addMember('volts', 'Current output voltage (get/set)');
                    addMember('slew', 'Slew time in seconds');
                    addMember('shape', 'Slew shape');
                    addMember('scale', 'Quantize scale');
                    addMember('action', 'ASL action');
                    addMember('done', 'Callback when ASL action completes');
                    addMember('dyn', 'Dynamic variables for ASL');
                    addMember('clock_div', 'Clock division (after :clock())');
                } else if (!isMemberContext && /\bclock\.(\w*)$/.test(before)) {
                    isMemberContext = true;
                    addMember('tempo', 'Set clock tempo in BPM');
                    addMember('run', 'Run a function in a coroutine');
                    addMember('sleep', 'Sleep for specified time in seconds');
                    addMember('sync', 'Sleep until next sync at beat interval');
                    addMember('start', 'Start clock');
                    addMember('stop', 'Stop clock');
                    addMember('cancel', 'Cancel a running coroutine');
                    addMember('cleanup', 'Kill all running clocks');
                }

                const applyDefaultRange = (items, range) => items.map((it) => (it && it.range) ? it : ({ ...it, range }));
                const baseWithRange = applyDefaultRange(baseSuggestions, wordRange);
                const symbolsWithRange = applyDefaultRange(symbolSuggestions, wordRange);

                return {
                    suggestions: isMemberContext
                        ? [...memberSuggestions]
                        : [...memberSuggestions, ...symbolsWithRange, ...baseWithRange]
                };
            },
            triggerCharacters: ['^', '.', ':', '[', '{']
        });

        monaco.languages.registerHoverProvider('lua', {
            provideHover: (model, position) => {
                const expr = getHoverExpressionAtPosition(model, position);
                if (!expr) return null;

                const doc = docsByLabel.get(expr);
                if (!doc) {
                    // Ensure we have a cached symbol index for this model/version.
                    getSymbolSuggestions(model);
                    const cached = parseCache.get(getModelCacheKey(model));
                    const def = cached?.index?.defsByName?.get(expr) || app._sessionLuaGlobals.get(expr);
                    if (!def) return null;

                    const pos = def?.pos;
                    const where = pos?.line ? `line ${pos.line}:${pos.column}` : 'unknown location';
                    const kind = def.kind || 'variable';
                    const scope = def.scope ? ` (${def.scope})` : '';

                    return {
                        range: model.getWordAtPosition(position)
                            ? new monaco.Range(position.lineNumber, model.getWordAtPosition(position).startColumn, position.lineNumber, model.getWordAtPosition(position).endColumn)
                            : undefined,
                        contents: [
                            { value: `**${expr}**` },
                            { value: `User ${kind}${scope}, defined at ${where}` }
                        ]
                    };
                }

                return {
                    range: model.getWordAtPosition(position)
                        ? new monaco.Range(position.lineNumber, model.getWordAtPosition(position).startColumn, position.lineNumber, model.getWordAtPosition(position).endColumn)
                        : undefined,
                    contents: [
                        { value: `**${expr}**` },
                        { value: doc }
                    ]
                };
            }
        });

        // Register signature help provider
        monaco.languages.registerSignatureHelpProvider('lua', {
            signatureHelpTriggerCharacters: ['(', ','],
            provideSignatureHelp: (model, position) => {
                const textUntilPosition = model.getValueInRange({
                    startLineNumber: position.lineNumber,
                    startColumn: 1,
                    endLineNumber: position.lineNumber,
                    endColumn: position.column
                });

                // Find the function call we're in
                let functionMatch = null;
                const signatures = [];

                // Output actions
                if (textUntilPosition.match(/lfo\s*\(/)) {
                    signatures.push({
                        label: 'lfo(time, level, shape)',
                        documentation: 'Low frequency oscillator action',
                        parameters: [
                            { label: 'time', documentation: 'Period in seconds (default: 1)' },
                            { label: 'level', documentation: 'Output level in volts (default: 5)' },
                            { label: 'shape', documentation: "Waveform shape: 'sine', 'linear', 'expo', 'log' (default: 'sine')" }
                        ]
                    });
                } else if (textUntilPosition.match(/pulse\s*\(/)) {
                    signatures.push({
                        label: 'pulse(time, level, polarity)',
                        documentation: 'Trigger/gate generator action',
                        parameters: [
                            { label: 'time', documentation: 'Pulse duration in seconds (default: 0.01)' },
                            { label: 'level', documentation: 'Pulse height in volts (default: 5)' },
                            { label: 'polarity', documentation: 'Pulse direction: 1 or -1 (default: 1)' }
                        ]
                    });
                } else if (textUntilPosition.match(/ar\s*\(/)) {
                    signatures.push({
                        label: 'ar(attack, release, level, shape)',
                        documentation: 'Attack-release envelope',
                        parameters: [
                            { label: 'attack', documentation: 'Attack time in seconds (default: 0.05)' },
                            { label: 'release', documentation: 'Release time in seconds (default: 0.5)' },
                            { label: 'level', documentation: 'Peak level in volts (default: 7)' },
                            { label: 'shape', documentation: "Envelope shape: 'linear', 'log', 'expo' (default: 'log')" }
                        ]
                    });
                } else if (textUntilPosition.match(/adsr\s*\(/)) {
                    signatures.push({
                        label: 'adsr(attack, decay, sustain, release, shape)',
                        documentation: 'ADSR envelope',
                        parameters: [
                            { label: 'attack', documentation: 'Attack time in seconds (default: 0.05)' },
                            { label: 'decay', documentation: 'Decay time in seconds (default: 0.3)' },
                            { label: 'sustain', documentation: 'Sustain level in volts (default: 2)' },
                            { label: 'release', documentation: 'Release time in seconds (default: 2)' },
                            { label: 'shape', documentation: "Envelope shape: 'linear', 'log', 'expo' (default: 'linear')" }
                        ]
                    });
                } else if (textUntilPosition.match(/\bto\s*\(/)) {
                    signatures.push({
                        label: 'to(destination, time, shape)',
                        documentation: 'ASL primitive: move to destination over time',
                        parameters: [
                            { label: 'destination', documentation: 'Target voltage' },
                            { label: 'time', documentation: 'Time to reach destination in seconds' },
                            { label: 'shape', documentation: "Optional slope shape: 'linear', 'sine', 'logarithmic', 'exponential', etc." }
                        ]
                    });
                } else if (textUntilPosition.match(/clock\.run\s*\(/)) {
                    signatures.push({
                        label: 'clock.run(func, ...)',
                        documentation: 'Run a function in a coroutine',
                        parameters: [
                            { label: 'func', documentation: 'Function to run as a coroutine' },
                            { label: '...', documentation: 'Optional arguments passed to func' }
                        ]
                    });
                } else if (textUntilPosition.match(/clock\.sleep\s*\(/)) {
                    signatures.push({
                        label: 'clock.sleep(seconds)',
                        documentation: 'Sleep for specified time in seconds',
                        parameters: [
                            { label: 'seconds', documentation: 'Time to sleep in seconds' }
                        ]
                    });
                } else if (textUntilPosition.match(/clock\.sync\s*\(/)) {
                    signatures.push({
                        label: 'clock.sync(beats)',
                        documentation: 'Sleep until next sync at specified beat interval',
                        parameters: [
                            { label: 'beats', documentation: 'Beat interval (e.g., 1/4 for quarter notes)' }
                        ]
                    });
                } else if (textUntilPosition.match(/ii\.jf\.play_note\s*\(/)) {
                    signatures.push({
                        label: 'ii.jf.play_note(volts, level)',
                        documentation: 'Just Friends: play a note at specified voltage and level',
                        parameters: [
                            { label: 'volts', documentation: 'Pitch in volts (V/oct)' },
                            { label: 'level', documentation: 'Velocity/level (0.0-5.0)' }
                        ]
                    });
                } else if (textUntilPosition.match(/ii\.jf\.trigger\s*\(/)) {
                    signatures.push({
                        label: 'ii.jf.trigger(channel, state)',
                        documentation: 'Just Friends: set trigger state for channel',
                        parameters: [
                            { label: 'channel', documentation: 'Trigger channel (1-6)' },
                            { label: 'state', documentation: 'Trigger state (0 or 1)' }
                        ]
                    });
                } else if (textUntilPosition.match(/bb\.noise\s*\(/)) {
                    signatures.push({
                        label: 'bb.noise(gain)',
                        documentation: 'Blackbird: Generate audio-rate noise action',
                        parameters: [
                            { label: 'gain', documentation: 'Noise level (0.0-1.0, default: 1.0)' }
                        ]
                    });
                } else if (textUntilPosition.match(/bb\.priority\s*\(/)) {
                    signatures.push({
                        label: "bb.priority(mode)",
                        documentation: 'Blackbird: Set processing priority mode',
                        parameters: [
                            { label: 'mode', documentation: "'timing' (default), 'balanced', or 'accuracy'" }
                        ]
                    });
                }

                if (signatures.length > 0) {
                    return {
                        value: {
                            signatures: signatures,
                            activeSignature: 0,
                            activeParameter: this.getActiveParameter(textUntilPosition)
                        },
                        dispose: () => {}
                    };
                }

                return null;
            }
        });
    }

    getActiveParameter(text) {
        // Count commas after the opening parenthesis to determine active parameter
        const openParen = text.lastIndexOf('(');
        if (openParen === -1) return 0;
        
        const afterParen = text.substring(openParen + 1);
        const commas = (afterParen.match(/,/g) || []).length;
        return commas;
    }

    validateLuaSyntax() {
        if (!this.editor) return;
        
        // Check if luaparse is available
        if (typeof luaparse === 'undefined') {
            console.warn('luaparse library not loaded - syntax validation disabled');
            return;
        }

        const model = this.editor.getModel();
        const code = model.getValue();
        const markers = [];

        const KNOWN_GLOBALS = new Set([
            // Lua built-ins (5.3/5.4-ish)
            '_G', '_VERSION',
            'assert', 'collectgarbage', 'dofile', 'error', 'getmetatable', 'ipairs', 'load', 'loadfile',
            'next', 'pairs', 'pcall', 'print', 'rawequal', 'rawget', 'rawlen', 'rawset', 'require',
            'select', 'setmetatable', 'tonumber', 'tostring', 'type', 'xpcall',
            'coroutine', 'string', 'table', 'math', 'utf8', 'package',
            'io', 'os', 'debug',

            // crow globals / commonly used APIs
            'crow', 'input', 'output', 'metro', 'clock', 'delay', 'timeline', 'hotswap', 'ii', 'public', 'cal',
            'tell', 'quote', 'unique_id', 'time', 'cputime', 'justvolts', 'just12', 'hztovolts',
            'dyn', 'to', 'loop', 'held', 'lock', 'times', 'asl', 'sequins', 's',

            // host extensions / blackbird
            'tab', 'bb'
        ]);

        const walk = (node, visitor, parent = null, parentKey = null) => {
            if (!node || typeof node !== 'object') return;
            visitor(node, parent, parentKey);
            if (Array.isArray(node)) {
                for (let i = 0; i < node.length; i++) walk(node[i], visitor, node, i);
                return;
            }
            for (const [key, value] of Object.entries(node)) {
                if (!value || typeof value !== 'object') continue;
                walk(value, visitor, node, key);
            }
        };

        const isIdentifier = (n) => n && typeof n === 'object' && n.type === 'Identifier' && typeof n.name === 'string';

        const isDeclarationIdentifier = (node, parent, parentKey) => {
            if (!isIdentifier(node) || !parent || typeof parent !== 'object') return false;
            if (parent.type === 'LocalStatement' && parentKey === 'variables') return true;
            if ((parent.type === 'AssignmentStatement' || parent.type === 'LocalStatement') && parentKey === 'variables') return true;
            if (parent.type === 'ForNumericStatement' && parentKey === 'variable') return true;
            if (parent.type === 'ForGenericStatement' && parentKey === 'variables') return true;
            if (parent.type === 'FunctionDeclaration' && parentKey === 'parameters') return true;
            if (parent.type === 'FunctionDeclaration' && parentKey === 'identifier') return true;
            return false;
        };

        const isPropertyIdentifier = (node, parent, parentKey) => {
            if (!isIdentifier(node) || !parent || typeof parent !== 'object') return false;
            // foo.bar -> 'bar' should not be treated as a variable reference
            if (parent.type === 'MemberExpression' && parentKey === 'identifier') return true;
            // { key = value } -> 'key' is not a variable reference
            if (parent.type === 'TableKeyString' && parentKey === 'key') return true;
            return false;
        };

        // Use luaparse for proper Lua syntax validation
        try {
            luaparse.parse(code, {
                locations: true,
                ranges: true,
                luaVersion: '5.3'
            });

            // Lightweight undefined-name warnings (best-effort; not full Lua scoping).
            // Key behavior: treat `f = 3` as an explicit global declaration, but only
            // after that assignment appears (so `print(f)` before `f = 3` still warns).
            const index = this.extractLuaSymbolIndex(code);
            if (!index) {
                monaco.editor.setModelMarkers(model, 'lua', markers);
                return;
            }

            this._editorLuaSymbolIndex = index;
            this._editorLuaSymbolIndexVersionId = model.getVersionId();

            // Refresh session globals from the editor buffer.
            for (const [name, def] of index.globals.entries()) {
                const existing = this._sessionLuaGlobals.get(name);
                const next = { ...def, source: 'editor' };
                if (!existing) {
                    this._sessionLuaGlobals.set(name, next);
                    continue;
                }
                if (def?.pos && existing?.pos && this.compareLuaPositions(def.pos, existing.pos) < 0) {
                    this._sessionLuaGlobals.set(name, next);
                }
            }

            const known = new Set([...KNOWN_GLOBALS]);
            for (const name of this._sessionLuaGlobals.keys()) known.add(name);

            const MAX_UNDEFINED_MARKERS = 100;
            const emitted = new Set();
            for (const ref of index.refs) {
                if (markers.length >= MAX_UNDEFINED_MARKERS) break;
                const name = ref.name;
                if (known.has(name)) continue;

                const def = index.defsByName.get(name) || this._sessionLuaGlobals.get(name);
                if (!def) {
                    // Unknown name
                } else if (!def.pos || !ref.pos) {
                    // If we can't compare locations, assume defined.
                    continue;
                } else if (this.compareLuaPositions(def.pos, ref.pos) <= 0) {
                    continue;
                }

                const key = `${name}@${ref.pos?.line || 0}:${ref.pos?.column || 0}`;
                if (emitted.has(key)) continue;
                emitted.add(key);

                const startLineNumber = ref.pos?.line;
                const startColumn = ref.pos?.column;
                if (!startLineNumber || !startColumn) continue;

                markers.push({
                    severity: monaco.MarkerSeverity.Warning,
                    startLineNumber,
                    startColumn,
                    endLineNumber: startLineNumber,
                    endColumn: startColumn + name.length,
                    message: `Possibly undefined name: ${name}`
                });
            }

            monaco.editor.setModelMarkers(model, 'lua', markers);
        } catch (error) {
            // Parse error - extract line/column info
            if (error.line !== undefined) {
                const column = error.column !== undefined ? error.column : 1;
                markers.push({
                    severity: monaco.MarkerSeverity.Error,
                    startLineNumber: error.line,
                    startColumn: column,
                    endLineNumber: error.line,
                    endColumn: column + 1,
                    message: error.message || 'Syntax error'
                });
                monaco.editor.setModelMarkers(model, 'lua', markers);
            } else {
                console.error('Parse error without location info:', error);
            }
        }
    }

    setupSplitPane() {
        let isResizing = false;
        const container = this.elements.splitContainer;
        const handle = this.elements.splitHandle;
        const replPane = this.elements.replPane;
        const editorPane = this.elements.editorPane;

        handle.addEventListener('mousedown', (e) => {
            isResizing = true;
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            
            const containerRect = container.getBoundingClientRect();
            
            // Check if we're in vertical layout (either forced or responsive)
            const isForcedVertical = container.classList.contains('force-vertical');
            const isForcedHorizontal = container.classList.contains('force-horizontal');
            const isResponsiveVertical = !isForcedHorizontal && window.innerWidth <= 768;
            const isVertical = isForcedVertical || isResponsiveVertical;
            
            // Check which pane comes first in the DOM
            const editorFirst = editorPane.compareDocumentPosition(replPane) & Node.DOCUMENT_POSITION_FOLLOWING;
            
            if (isVertical) {
                // Vertical layout
                if (editorFirst) {
                    // Editor on top, REPL on bottom
                    const newReplHeight = containerRect.bottom - e.clientY;
                    const newEditorHeight = containerRect.height - newReplHeight;
                    
                    if (newReplHeight >= 200 && newEditorHeight >= 200) {
                        replPane.style.flex = `0 0 ${newReplHeight}px`;
                        editorPane.style.flex = `0 0 ${newEditorHeight}px`;
                    }
                } else {
                    // REPL on top, editor on bottom
                    const newReplHeight = e.clientY - containerRect.top;
                    const newEditorHeight = containerRect.height - newReplHeight;
                    
                    if (newReplHeight >= 200 && newEditorHeight >= 200) {
                        replPane.style.flex = `0 0 ${newReplHeight}px`;
                        editorPane.style.flex = `0 0 ${newEditorHeight}px`;
                    }
                }
            } else {
                // Horizontal layout
                if (editorFirst) {
                    // Editor on left, REPL on right
                    const newReplWidth = containerRect.right - e.clientX;
                    const newEditorWidth = containerRect.width - newReplWidth;
                    
                    if (newReplWidth >= 200 && newEditorWidth >= 200) {
                        replPane.style.flex = `0 0 ${newReplWidth}px`;
                        editorPane.style.flex = `0 0 ${newEditorWidth}px`;
                    }
                } else {
                    // REPL on left, editor on right
                    const newReplWidth = e.clientX - containerRect.left;
                    const newEditorWidth = containerRect.width - newReplWidth;
                    
                    if (newReplWidth >= 200 && newEditorWidth >= 200) {
                        replPane.style.flex = `0 0 ${newReplWidth}px`;
                        editorPane.style.flex = `0 0 ${newEditorWidth}px`;
                    }
                }
            }
        });

        document.addEventListener('mouseup', () => {
            if (isResizing) {
                this.captureSplitState();
            }
            isResizing = false;
        });
    }

    setLayout(layout) {
        const container = this.elements.splitContainer;
        const replPane = this.elements.replPane;
        const editorPane = this.elements.editorPane;
        const swapBtn = this.elements.swapPanesBtn;
        const swapHorizontal = swapBtn.querySelector('.swap-horizontal');
        const swapVertical = swapBtn.querySelector('.swap-vertical');
        
        if (layout === 'vertical') {
            container.classList.add('force-vertical');
            container.classList.remove('force-horizontal');
            this.elements.horizontalLayoutBtn.classList.remove('active');
            this.elements.verticalLayoutBtn.classList.add('active');
            
            // Show vertical arrows for vertical layout
            swapHorizontal.style.display = 'none';
            swapVertical.style.display = 'block';
            
            // Set 50/50 split for vertical layout (and keep it responsive on resize)
            this.splitState = { orientation: 'vertical', replFraction: 0.5 };
            this.applySplitState();
        } else {
            container.classList.add('force-horizontal');
            container.classList.remove('force-vertical');
            this.elements.horizontalLayoutBtn.classList.add('active');
            this.elements.verticalLayoutBtn.classList.remove('active');
            
            // Show horizontal arrows for horizontal layout
            swapHorizontal.style.display = 'block';
            swapVertical.style.display = 'none';
            
            // Reset to 50/50 split for horizontal layout (and keep it responsive on resize)
            this.splitState = { orientation: 'horizontal', replFraction: 0.5 };
            this.applySplitState();
        }
    }

    swapPanes() {
        const container = this.elements.splitContainer;
        const editorPane = this.elements.editorPane;
        const splitHandle = this.elements.splitHandle;
        const replPane = this.elements.replPane;
        
        // Get current order by checking which comes first
        const editorFirst = editorPane.compareDocumentPosition(replPane) & Node.DOCUMENT_POSITION_FOLLOWING;
        
        if (editorFirst) {
            // Currently: editor, handle, repl -> swap to: repl, handle, editor
            container.insertBefore(replPane, editorPane);
            container.insertBefore(splitHandle, editorPane);
        } else {
            // Currently: repl, handle, editor -> swap to: editor, handle, repl
            container.insertBefore(editorPane, replPane);
            container.insertBefore(splitHandle, replPane);
        }
        
        // Reset to 50/50 split after swapping (and keep it responsive on resize)
        const orientation = this.getCurrentSplitOrientation();
        this.splitState = { orientation, replFraction: 0.5 };
        this.applySplitState();
    }

    async handleReplInput(e) {
        // Only process if this textarea is actually focused
        // (prevents interference when Monaco REPL editor is active)
        if (document.activeElement !== this.elements.replInput) {
            return;
        }
        
        // Handle arrow key navigation through command history
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (this.commandHistory.length === 0) return;
            
            // Save current input if we're not already browsing history
            if (this.historyIndex === -1) {
                this.currentInput = this.elements.replInput.value;
            }
            
            // Navigate up in history (older commands)
            if (this.historyIndex < this.commandHistory.length - 1) {
                this.historyIndex++;
                this.elements.replInput.value = this.commandHistory[this.commandHistory.length - 1 - this.historyIndex];
            }
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (this.historyIndex === -1) return;
            
            // Navigate down in history (newer commands)
            this.historyIndex--;
            if (this.historyIndex === -1) {
                // Restore the current input that was being typed
                this.elements.replInput.value = this.currentInput;
            } else {
                this.elements.replInput.value = this.commandHistory[this.commandHistory.length - 1 - this.historyIndex];
            }
        } else if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            const code = this.elements.replInput.value.trim();
            if (code) {
                // Output the sent command BEFORE sending to ensure it appears first
                this.outputLine(`>> ${code}`);
                
                // Add to command history (avoid duplicates of the last command)
                // This happens regardless of connection status
                if (this.commandHistory.length === 0 || this.commandHistory[this.commandHistory.length - 1] !== code) {
                    this.commandHistory.push(code);
                }
                
                if (!this.crow.isConnected) {
                    this.outputLine('crow is not connected');
                    this.elements.replInput.value = '';
                    // Reset history navigation
                    this.historyIndex = -1;
                    this.currentInput = '';
                    return;
                }
                
                try {
                    const lines = code.split('\n');
                    for (const line of lines) {
                        await this.crow.writeLine(line);
                        await this.delay(1);
                    }
                    
                    // Reset history navigation
                    this.historyIndex = -1;
                    this.currentInput = '';
                    this.elements.replInput.value = '';
                } catch (error) {
                    this.outputLine(`Error: ${error.message}`);
                }
            }
        } else {
            // Reset history index when user starts typing
            if (this.historyIndex !== -1) {
                this.historyIndex = -1;
                this.currentInput = '';
            }
        }
    }

    handleKeyboardShortcut(e) {
        const isMeta = e.metaKey || e.ctrlKey;
        
        // Check if any Monaco editor has focus
        const editorHasFocus = this.editor && this.editor.hasTextFocus();
        const replEditorHasFocus = this.replEditor && this.replEditor.hasTextFocus();
        const replTextareaHasFocus = document.activeElement === this.elements.replInput;
        
        // If any editor has focus and it's not a meta command, don't process
        if (!isMeta && (editorHasFocus || replEditorHasFocus || replTextareaHasFocus)) {
            return;
        }
        
        // Only process keyboard shortcuts if they're meta/ctrl commands
        if (isMeta && e.key === 'p') {
            e.preventDefault();
            this.runScript();
        } else if (isMeta && e.key === 's') {
            e.preventDefault();
            this.saveScript();
        }
    }

    async toggleConnection() {
        if (this.crow.isConnected) {
            await this.disconnect();
        } else {
            await this.connect();
        }
    }

    async connect() {
        this.outputLine('Connecting to crow...');
        const success = await this.crow.connect();
        if (success) {
            this.outputLine('Connected! Ready to code.\nDrag and drop a lua file here to auto-upload.\n');
        }
    }

    async disconnect() {
        await this.crow.disconnect();
        this.outputLine('\nDisconnected from crow.\n');
    }

    handleConnectionChange(connected, error) {
        this.elements.runBtn.disabled = !connected;
        this.elements.uploadBtn.disabled = !connected;

        if (connected) {
            this.elements.connectionBtn.textContent = 'disconnect';
            this.elements.replStatusIndicator.classList.add('connected');
            this.elements.replStatusText.textContent = 'connected';
            
            // Focus the appropriate input
            if (this.replAutocompleteEnabled && this.replEditor) {
                this.replEditor.focus();
            } else {
                this.elements.replInput.focus();
            }
        } else {
            this.elements.connectionBtn.textContent = 'connect';
            this.elements.replStatusIndicator.classList.remove('connected');
            const statusMsg = error || 'not connected';
            this.elements.replStatusText.textContent = statusMsg;
            
            // Show disconnection message in REPL
            if (error && error.includes('disconnected')) {
                this.outputLine(`\n${error}`);
            }
        }
    }

    handleCrowOutput(data) {
        const cleaned = data.replace(/\r/g, '');
        if (!cleaned) return;
        
        // Filter out pubview messages entirely - check for both formats
        // ^^pubview(...) or pubview(...)
        if (cleaned.includes('pubview(')) {
            return;
        }
        
        // Parse messages similar to monome/druid's process_line
        // Check if line contains ^^ events
        if (cleaned.includes('^^')) {
            const parts = cleaned.split('^^');
            for (const part of parts) {
                if (!part.trim()) continue;
                
                // Try to parse as event(args) format
                const match = part.match(/^(\w+)\(([^)]*)\)/);
                if (match) {
                    const event = match[1];
                    const argsStr = match[2];
                    const args = argsStr ? argsStr.split(',').map(s => s.trim()) : [];
                    
                    this.handleCrowEvent(event, args);
                } else {
                    // Not a recognized event format, output as-is
                    if (part.trim()) {
                        this.outputLine(part);
                    }
                }
            }
        } else {
            // No ^^ prefix - this is regular output
            this.outputLine(cleaned);
        }
    }

    handleCrowEvent(event, args) {
        // Handle specific crow events (messages with ^^ prefix)
        switch (event) {
            case 'pubview':
                // Silently filter out pubview messages - for internal browser use
                return;
                
            case 'stream':
            case 'change':
                // Input monitoring events - parse and display in stream monitors
                if (args.length >= 2) {
                    const channel = parseInt(args[0]);
                    const value = parseFloat(args[1]);
                    
                    if (channel === 1 || channel === 2) {
                        this.updateStreamMonitor(channel, value);
                    }
                }
                break;
                
            case 'pupdate':
                // Parameter updates - silently ignored
                return;
                
            default:
                // Output other events
                this.outputLine(`^^${event}(${args.join(', ')})`);
                break;
        }
    }

    updateStreamMonitor(channel, value) {
        // Show monitor if this is the first stream message for this channel
        const monitorElement = document.getElementById(`streamMonitor${channel}`);
        if (monitorElement && !monitorElement.classList.contains('active')) {
            monitorElement.classList.add('active');
        }
        
        // Add value with timestamp (keep last 5 seconds of data)
        const now = Date.now();
        this.streamData[channel].push({ time: now, value: value });
        
        // Remove data older than 5 seconds
        const cutoff = now - 5000; // 5 seconds in milliseconds
        while (this.streamData[channel].length > 0 && this.streamData[channel][0].time < cutoff) {
            this.streamData[channel].shift();
        }
        
        // Update value display
        const valueElement = this.elements[`streamValue${channel}`];
        valueElement.textContent = value.toFixed(4) + 'V';
        
        // Graph is continuously drawn by animation loop
    }

    startStreamAnimation() {
        const animate = () => {
            // Redraw both monitors if they have data and are visible
            const monitor1 = document.getElementById('streamMonitor1');
            const monitor2 = document.getElementById('streamMonitor2');
            
            if (monitor1 && monitor1.classList.contains('active') && this.streamData[1].length > 0) {
                this.drawStreamGraph(1);
            }
            if (monitor2 && monitor2.classList.contains('active') && this.streamData[2].length > 0) {
                this.drawStreamGraph(2);
            }
            
            requestAnimationFrame(animate);
        };
        
        requestAnimationFrame(animate);
    }

    drawStreamGraph(channel) {
        const canvas = this.elements[`streamCanvas${channel}`];
        const ctx = this.streamContexts[channel];
        const data = this.streamData[channel];
        
        if (!ctx || data.length === 0) return;
        
        const width = canvas.width;
        const height = canvas.height;
        const padding = 4;
        const graphHeight = height - (padding * 2);
        const graphWidth = width - (padding * 2);
        
        // Clear canvas
        ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg-subdued').trim();
        ctx.fillRect(0, 0, width, height);
        
        // Find min/max for scaling - start with -5V to +5V range and expand if needed
        let minV = -5;
        let maxV = 5;
        
        // Check if any values exceed the default range
        data.forEach(point => {
            if (point.value < minV) minV = Math.floor(point.value);
            if (point.value > maxV) maxV = Math.ceil(point.value);
        });
        
        const range = maxV - minV;
        
        // Draw zero line
        const zeroY = padding + graphHeight - ((0 - minV) / range * graphHeight);
        ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--neutral-medium').trim();
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(padding, zeroY);
        ctx.lineTo(width - padding, zeroY);
        ctx.stroke();
        
        // Draw waveform based on time (5 second window)
        ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--interactive-selected').trim();
        ctx.lineWidth = 2;
        ctx.beginPath();
        
        const now = Date.now();
        const timeWindow = 5000; // 5 seconds in milliseconds
        
        data.forEach((point, index) => {
            // Map time to x position (right edge is now, left edge is 6 seconds ago)
            const timeFromNow = now - point.time;
            const x = padding + graphWidth - (timeFromNow / timeWindow * graphWidth);
            const y = padding + graphHeight - ((point.value - minV) / range * graphHeight);
            
            if (index === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        });
        
        ctx.stroke();
    }

    async runScript() {
        if (!this.crow.isConnected || !this.editor) return;
        
        this.outputLine(`Running ${this.scriptName}...`);
        const code = this.editor.getValue();
        
        try {
            await this.crow.writeLine('crow.reset()');
            await this.delay(100);
            await this.crow.writeLine('^^s'); // start script upload
            await this.delay(200);
            
            const lines = code.split('\n');
            for (const line of lines) {
                await this.crow.writeLine(line);
                await this.delay(1);
            }
            
            await this.crow.writeLine('^^e'); // execute script
            await this.delay(100);
        } catch (error) {
            this.outputLine(`Run error: ${error.message}\n`);
        }
    }

    async uploadScript() {
        if (!this.crow.isConnected || !this.editor) return;
        
        this.outputLine(`Uploading ${this.scriptName}...`);
        const code = this.editor.getValue();
        
        try {
            await this.crow.writeLine('^^s'); // start script upload
            await this.delay(200);
            
            const lines = code.split('\n');
            for (const line of lines) {
                await this.crow.writeLine(line);
                await this.delay(1);
            }
            
            await this.crow.writeLine('^^w'); // write to flash
            await this.delay(100);
            this.setModified(false);
        } catch (error) {
            this.outputLine(`Upload error: ${error.message}\n`);
        }
    }

    newScript() {
        if (this.scriptModified) {
            if (!confirm('You have unsaved changes. Create new script anyway?')) {
                return;
            }
        }
        
        this.scriptName = 'untitled.lua';
        this.currentFile = null;
        this.editor.setValue('-- crow script\n\nfunction init()\n  print("hello crow")\nend\n');
        this.setModified(false);
        this.updateScriptName();
    }

    openScript() {
        this.elements.fileInput.click();
    }

    async handleFileSelect(e) {
        const file = e.target.files[0];
        if (!file) return;

        const content = await file.text();
        this.scriptName = file.name;
        this.currentFile = file;
        this.editor.setValue(content);
        this.setModified(false);
        this.updateScriptName();
        
        this.elements.fileInput.value = '';
    }

    saveScript() {
        if (!this.editor) return;
        
        const content = this.editor.getValue();
        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = this.scriptName;
        a.click();
        URL.revokeObjectURL(url);
        
        this.setModified(false);
    }

    renameScript() {
        const currentName = this.scriptName.replace(' •', '');
        const newName = prompt('Rename script:', currentName);
        
        if (newName && newName.trim() && newName !== currentName) {
            this.scriptName = newName.trim();
            if (!this.scriptName.endsWith('.lua')) {
                this.scriptName += '.lua';
            }
            this.updateScriptName();
        }
    }

    setModified(modified) {
        this.scriptModified = modified;
        this.updateScriptName();
    }

    updateScriptName() {
        const displayName = this.scriptModified ? `${this.scriptName} •` : this.scriptName;
        this.elements.scriptName.textContent = displayName;
    }

    loadRemoteScriptIntoEditor(name, content) {
        this.scriptName = name;
        this.currentFile = null;
        this.updateScriptName();

        if (this.editor) {
            this._suppressEditorChange = true;
            try {
                this.editor.setValue(content);
            } finally {
                this._suppressEditorChange = false;
            }
        }

        this.setModified(false);
        this.validateLuaSyntax();
    }

    toggleEditor(show) {
        this.editorVisible = show;
        
        if (show) {
            // Show editor
            this.elements.toolbar.classList.remove('hidden');
            this.elements.editorPane.classList.remove('hidden');
            this.elements.splitHandle.classList.remove('hidden');
            this.elements.replPane.classList.remove('full-width');
            
            // Reset to 50/50 split when showing the editor (and keep it responsive on resize)
            const orientation = this.getCurrentSplitOrientation();
            this.splitState = { orientation, replFraction: 0.5 };
            this.applySplitState();
            
            // Re-layout Monaco editor
            if (this.editor) {
                this.editor.layout();
            }
        } else {
            // Hide editor - reset flex styles so REPL can take full width
            this.elements.toolbar.classList.add('hidden');
            this.elements.editorPane.classList.add('hidden');
            this.elements.splitHandle.classList.add('hidden');
            this.elements.replPane.classList.add('full-width');
            
            // Clear inline flex styles to let CSS take over
            this.elements.replPane.style.flex = '';
            this.elements.editorPane.style.flex = '';

            // Clear saved split state
            this.splitState = null;
        }
    }

    outputLine(text) {
        this.outputText(text + '\n');
    }

    outputText(text) {
        const textNode = document.createTextNode(text);
        this.elements.output.appendChild(textNode);
        this.elements.output.scrollTop = this.elements.output.scrollHeight;
    }
    
    outputHTML(html) {
        const span = document.createElement('span');
        span.innerHTML = html;
        this.elements.output.appendChild(span);
        this.elements.output.scrollTop = this.elements.output.scrollHeight;
    }

    clearOutput() {
        this.elements.output.textContent = '';
        this.hideStreamMonitors();
    }

    hideStreamMonitors() {
        const monitor1 = document.getElementById('streamMonitor1');
        const monitor2 = document.getElementById('streamMonitor2');
        if (monitor1) monitor1.classList.remove('active');
        if (monitor2) monitor2.classList.remove('active');
    }

    resetCrow() {
        if (!this.crow.isConnected) {
            this.outputLine('Error: Not connected to usb device');
            return;
        }
        this.outputLine('> crow.reset()');
        this.crow.writeLine('crow.reset()');  
        this.hideStreamMonitors();
    }

    showHelp() {
        this.outputLine('');
        this.outputLine(' crow commands:');
        this.outputLine(' ^^i          print identity');
        this.outputLine(' ^^v          print version');
        this.outputLine(' ^^p          print current userscript');
        this.outputLine(' ^^r          restart crow');
        this.outputLine(' ^^k          kill running script');
        this.outputLine(' ^^c          clear userscript from flash');
        this.outputLine(' ^^b          enter bootloader mode');
        this.outputLine('');
        this.outputHTML(' crow script reference: <a href="https://monome.org/docs/crow/reference" target="_blank">https://monome.org/docs/crow/reference</a>\n');
        this.outputLine('');
        this.outputHTML(' blackbird addendum: <a href="https://github.com/TomWhitwell/Workshop_Computer/tree/main/releases/41_blackbird/README.md" target="_blank">https://github.com/TomWhitwell/Workshop_Computer/tree/main/releases/41_blackbird/README.md</a>\n');
        this.outputLine('');
    }

    setupDragAndDrop() {
        // Prevent default drag behaviors on the whole document
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            document.body.addEventListener(eventName, (e) => {
                e.preventDefault();
                e.stopPropagation();
            }, false);
        });

        // Editor pane drop
        this.elements.editorPane.addEventListener('drop', async (e) => {
            const files = e.dataTransfer.files;
            if (files.length > 0) {
                const file = files[0];
                if (file.name.endsWith('.lua')) {
                    await this.loadFileFromDrop(file);
                } else {
                    this.outputLine('Error: Only .lua files are supported');
                }
            }
        });

        // REPL pane drop
        this.elements.replPane.addEventListener('drop', async (e) => {
            const files = e.dataTransfer.files;
            if (files.length > 0) {
                const file = files[0];
                if (file.name.endsWith('.lua')) {
                    await this.uploadFileFromDrop(file);
                } else {
                    this.outputLine('Error: Only .lua files are supported');
                }
            }
        });

        // Visual feedback on dragover
        this.elements.editorPane.addEventListener('dragover', (e) => {
            this.elements.editorPane.style.opacity = '0.7';
        });

        this.elements.editorPane.addEventListener('dragleave', (e) => {
            this.elements.editorPane.style.opacity = '1';
        });

        this.elements.editorPane.addEventListener('drop', (e) => {
            this.elements.editorPane.style.opacity = '1';
        });

        this.elements.replPane.addEventListener('dragover', (e) => {
            this.elements.replPane.style.opacity = '0.7';
        });

        this.elements.replPane.addEventListener('dragleave', (e) => {
            this.elements.replPane.style.opacity = '1';
        });

        this.elements.replPane.addEventListener('drop', (e) => {
            this.elements.replPane.style.opacity = '1';
        });
    }

    async loadFileFromDrop(file) {
        try {
            const text = await file.text();
            this.scriptName = file.name;
            this.currentFile = null; // Reset file handle since this is drag-drop
            if (this.editor) {
                this.editor.setValue(text);
            }
            this.setModified(false);
            this.updateScriptName();
            this.outputLine(`Loaded ${file.name} into editor`);
        } catch (error) {
            this.outputLine(`Error loading file: ${error.message}`);
        }
    }

    async uploadFileFromDrop(file) {
        if (!this.crow.isConnected) {
            this.outputLine('Error: Not connected to usb device (click connect in the header)');
            return;
        }

        try {
            const text = await file.text();
            this.outputLine(`Uploading ${file.name}...`);
            
            await this.crow.writeLine('^^s');
            await this.delay(200);
            
            const lines = text.split('\\n');
            for (const line of lines) {
                await this.crow.writeLine(line);
                await this.delay(1);
            }
            
            await this.crow.writeLine('^^w');
            await this.delay(100);
        } catch (error) {
            this.outputLine(`Upload error: ${error.message}\\n`);
        }
    }

    async sendToCrow(code) {
        if (!this.crow.isConnected) {
            this.outputLine('Error: Not connected to usb device (click connect in the header)');
            return;
        }

        try {
            const normalizedCode = String(code)
                .replace(/\r\n/g, '\n')
                .replace(/\r/g, '\n');

            // Track globals defined by this code so they can be suggested later.
            this.updateSessionLuaGlobalsFromCode(normalizedCode, 'editor');

            const preparedCode = this.prepareCodeForCrow(normalizedCode);

            const lines = preparedCode.split('\n');
            for (const line of lines) {
                await this.crow.writeLine(line);
                await this.delay(1);
            }
            this.outputLine(`>> ${preparedCode.replace(/\n/g, '\n>> ')}`);
        } catch (error) {
            this.outputLine(`Error: ${error.message}`);
        }
    }

    prepareCodeForCrow(code) {
        const trimmed = code.trim();
        const alreadyFenced = trimmed.startsWith('```') && trimmed.endsWith('```');
        if (alreadyFenced) {
            return code;
        }

        const isMultiline = code.includes('\n');
        if (!isMultiline) {
            return code;
        }

        const withoutTrailingNewlines = code.replace(/\n+$/g, '');
        return `\`\`\`\n${withoutTrailingNewlines}\n\`\`\``;
    }

    async openBoweryBrowser() {
        this.elements.boweryModal.style.display = 'flex';
        this.elements.boweryLoading.style.display = 'block';
        this.elements.boweryError.style.display = 'none';
        this.elements.boweryList.style.display = 'none';
        this.elements.bowerySearch.value = '';
        
        // Update action text based on editor visibility
        if (this.isEditorVisible()) {
            this.elements.boweryAction.textContent = 'Select a script to load it into the editor';
        } else {
            this.elements.boweryAction.textContent = 'Select a script to upload it directly to crow';
        }
        
        try {
            // Fetch the repo tree from GitHub API
            const response = await fetch('https://api.github.com/repos/monome/bowery/git/trees/main?recursive=1');
            
            if (!response.ok) {
                throw new Error(`GitHub API error: ${response.status}`);
            }
            
            const data = await response.json();
            
            // Filter for .lua files only, excluding snippets and legacy directories
            this.boweryScripts = data.tree
                .filter(item => 
                    item.type === 'blob' && 
                    item.path.endsWith('.lua') &&
                    !item.path.startsWith('snippets/') &&
                    !item.path.startsWith('legacy/')
                )
                .map(item => ({
                    name: item.path.split('/').pop(),
                    path: item.path,
                    size: item.size,
                    url: `https://raw.githubusercontent.com/monome/bowery/main/${item.path}`
                }))
                .sort((a, b) => a.name.localeCompare(b.name));
            
            this.displayBoweryScripts(this.boweryScripts);
            
            this.elements.boweryLoading.style.display = 'none';
            this.elements.boweryList.style.display = 'block';
            
        } catch (error) {
            this.elements.boweryLoading.style.display = 'none';
            this.elements.boweryError.style.display = 'block';
            this.elements.boweryError.textContent = `Error loading bowery scripts: ${error.message}`;
        }
    }

    displayBoweryScripts(scripts) {
        this.elements.boweryList.innerHTML = '';
        
        if (scripts.length === 0) {
            this.elements.boweryList.innerHTML = '<div style="padding: 2rem; text-align: center; color: var(--neutral-medium);">No scripts found</div>';
            return;
        }
        
        scripts.forEach(script => {
            const item = document.createElement('div');
            item.className = 'bowery-item';
            
            const name = document.createElement('div');
            name.className = 'bowery-item-name';
            name.textContent = script.name;
            
            const path = document.createElement('div');
            path.className = 'bowery-item-path';
            path.textContent = script.path;
            
            const size = document.createElement('div');
            size.className = 'bowery-item-size';
            size.textContent = `${(script.size / 1024).toFixed(1)} KB`;
            
            item.appendChild(name);
            item.appendChild(path);
            item.appendChild(size);
            
            item.addEventListener('click', () => this.loadBoweryScript(script));
            
            this.elements.boweryList.appendChild(item);
        });
    }

    filterBoweryScripts(query) {
        if (!this.boweryScripts) return;
        
        const filtered = this.boweryScripts.filter(script => {
            const searchText = `${script.name} ${script.path}`.toLowerCase();
            return searchText.includes(query.toLowerCase());
        });
        
        this.displayBoweryScripts(filtered);
    }

    async loadBoweryScript(script) {
        try {
            this.elements.boweryModal.style.display = 'none';
            
            const response = await fetch(script.url);
            if (!response.ok) {
                throw new Error(`Failed to fetch (check connection): ${response.status}`);
            }
            
            const content = await response.text();
            
            // If editor is visible, load into editor
            if (this.isEditorVisible()) {
                this.loadRemoteScriptIntoEditor(script.name, content);
            } else {
                // If editor is hidden, auto-upload to crow
                if (!this.crow.isConnected) {
                    this.outputLine('Error: Not connected to usb device (click connect in the header)');
                    return;
                }
                
                this.outputLine(`Uploading ${script.name}...`);
                await this.crow.writeLine('^^s');
                await this.delay(200);
                
                const lines = content.split('\n');
                for (const line of lines) {
                    await this.crow.writeLine(line);
                    await this.delay(1);
                }
                
                await this.crow.writeLine('^^w');
                await this.delay(100);
            }
        } catch (error) {
            this.outputLine(`Error: ${error.message}`);
        }
    }

    async openBbboweryBrowser() {
        this.elements.bbboweryModal.style.display = 'flex';
        this.elements.bbboweryLoading.style.display = 'block';
        this.elements.bbboweryError.style.display = 'none';
        this.elements.bbboweryList.style.display = 'none';
        this.elements.bbbowerySearch.value = '';
        
        // Update action text based on editor visibility
        if (this.isEditorVisible()) {
            this.elements.bbboweryAction.textContent = '(bbbowery scripts require MTM Workshop Computer)';
        } else {
            this.elements.bbboweryAction.textContent = '(bbbowery scripts require MTM Workshop Computer)';
        }
        
        try {
            // Fetch the repo tree from GitHub API
            const response = await fetch('https://api.github.com/repos/dessertplanet/Workshop_Computer/git/trees/main?recursive=1');
            
            if (!response.ok) {
                throw new Error(`GitHub API error: ${response.status}`);
            }
            
            const data = await response.json();
            
            // Filter for .lua files in the bbbowery directory
            this.bbboweryScripts = data.tree
                .filter(item => 
                    item.type === 'blob' && 
                    item.path.startsWith('releases/41_blackbird/examples/bbbowery/') &&
                    item.path.endsWith('.lua')
                )
                .map(item => ({
                    name: item.path.split('/').pop(),
                    path: `bbbowery/${item.path.split('/').pop()}`,
                    size: item.size,
                    url: `https://raw.githubusercontent.com/dessertplanet/Workshop_Computer/main/${item.path}`
                }))
                .sort((a, b) => a.name.localeCompare(b.name));
            
            this.displayBbboweryScripts(this.bbboweryScripts);
            
            this.elements.bbboweryLoading.style.display = 'none';
            this.elements.bbboweryList.style.display = 'block';
            
        } catch (error) {
            this.elements.bbboweryLoading.style.display = 'none';
            this.elements.bbboweryError.style.display = 'block';
            this.elements.bbboweryError.textContent = `Error loading bbbowery scripts: ${error.message}`;
        }
    }

    displayBbboweryScripts(scripts) {
        this.elements.bbboweryList.innerHTML = '';
        
        if (scripts.length === 0) {
            this.elements.bbboweryList.innerHTML = '<div style="padding: 2rem; text-align: center; color: var(--neutral-medium);">No scripts found</div>';
            return;
        }
        
        scripts.forEach(script => {
            const item = document.createElement('div');
            item.className = 'bowery-item';
            
            const name = document.createElement('div');
            name.className = 'bowery-item-name';
            name.textContent = script.name;
            
            const path = document.createElement('div');
            path.className = 'bowery-item-path';
            path.textContent = script.path;
            
            const size = document.createElement('div');
            size.className = 'bowery-item-size';
            size.textContent = `${(script.size / 1024).toFixed(1)} KB`;
            
            item.appendChild(name);
            item.appendChild(path);
            item.appendChild(size);
            
            item.addEventListener('click', () => this.loadBbboweryScript(script));
            
            this.elements.bbboweryList.appendChild(item);
        });
    }

    filterBbboweryScripts(query) {
        if (!this.bbboweryScripts) return;
        
        const filtered = this.bbboweryScripts.filter(script => {
            const searchText = `${script.name} ${script.path}`.toLowerCase();
            return searchText.includes(query.toLowerCase());
        });
        
        this.displayBbboweryScripts(filtered);
    }

    async loadBbboweryScript(script) {
        try {
            this.elements.bbboweryModal.style.display = 'none';
            
            const response = await fetch(script.url);
            if (!response.ok) {
                throw new Error(`Failed to fetch (check connection): ${response.status}`);
            }
            
            const content = await response.text();
            
            // If editor is visible, load into editor
            if (this.isEditorVisible()) {
                this.loadRemoteScriptIntoEditor(script.name, content);
            } else {
                // If editor is hidden, auto-upload to blackbird
                if (!this.crow.isConnected) {
                    this.outputLine('Error: Not connected to usb device (click connect in the header)');
                    return;
                }
                
                this.outputLine(`Uploading ${script.name}...`);
                await this.crow.writeLine('^^s');
                await this.delay(200);
                
                const lines = content.split('\n');
                for (const line of lines) {
                    await this.crow.writeLine(line);
                    await this.delay(1);
                }
                
                await this.crow.writeLine('^^w');
                await this.delay(100);
            }
        } catch (error) {
            this.outputLine(`Error: ${error.message}`);
        }
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Initialize app when page loads
let druid;
window.addEventListener('DOMContentLoaded', () => {
    druid = new DruidApp();
});
