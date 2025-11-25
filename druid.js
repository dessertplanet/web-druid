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
                    this.onDataReceived(value);
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
        this.scriptName = 'untitled.lua';
        this.scriptModified = false;
        this.currentFile = null;
        
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
            helpBtn: document.getElementById('helpBtn'),
            clearBtn: document.getElementById('clearBtn'),
            
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
    }

    initializeEditor() {
        require.config({ paths: { vs: 'node_modules/monaco-editor/min/vs' } });
        
        require(['vs/editor/editor.main'], () => {
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
            // Check if suggestion widget is visible by querying the DOM
            const suggestWidget = document.querySelector('.editor-widget.suggest-widget.visible');
            const isSuggestVisible = suggestWidget !== null;
            
            // Check if a suggestion is actually selected (has the focused class)
            const isSuggestionSelected = isSuggestVisible && 
                suggestWidget.querySelector('.monaco-list-row.focused') !== null;
            
            // Handle Enter key
            if (keyCode === monaco.KeyCode.Enter && !e.shiftKey) {
                // If suggestion widget is visible AND a suggestion is selected, let Monaco handle it
                if (isSuggestionSelected) {
                    return;
                }
                // Otherwise, send the command
                const code = this.replEditor.getValue().trim();
                if (code) {
                    e.preventDefault();
                    e.stopPropagation();
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
            // Clear any previous error markers
            monaco.editor.setModelMarkers(model, 'lua', []);
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
        monaco.languages.registerCompletionItemProvider('lua', {
            provideCompletionItems: (model, position) => {
                // Get the text before the cursor to detect if user has typed "^" or "^^"
                const lineContent = model.getLineContent(position.lineNumber);
                const textBeforeCursor = lineContent.substring(0, position.column - 1);
                const match = textBeforeCursor.match(/\^*$/);
                const caretCount = match ? match[0].length : 0;
                
                // Create a range that will replace any existing "^" characters
                const replaceRange = new monaco.Range(
                    position.lineNumber,
                    position.column - caretCount,
                    position.lineNumber,
                    position.column
                );
                
                const suggestions = [
                    // Crow control commands
                    {
                        label: '^^i',
                        kind: monaco.languages.CompletionItemKind.Keyword,
                        insertText: '^^i',
                        filterText: '^^i',
                        sortText: '0^^i',
                        range: replaceRange,
                        documentation: 'Print identity'
                    },
                    {
                        label: '^^v',
                        kind: monaco.languages.CompletionItemKind.Keyword,
                        insertText: '^^v',
                        filterText: '^^v',
                        sortText: '0^^v',
                        range: replaceRange,
                        documentation: 'Print version'
                    },
                    {
                        label: '^^p',
                        kind: monaco.languages.CompletionItemKind.Keyword,
                        insertText: '^^p',
                        filterText: '^^p',
                        sortText: '0^^p',
                        range: replaceRange,
                        documentation: 'Print current userscript'
                    },
                    {
                        label: '^^r',
                        kind: monaco.languages.CompletionItemKind.Keyword,
                        insertText: '^^r',
                        filterText: '^^r',
                        sortText: '0^^r',
                        range: replaceRange,
                        documentation: 'Restart crow'
                    },
                    {
                        label: '^^k',
                        kind: monaco.languages.CompletionItemKind.Keyword,
                        insertText: '^^k',
                        filterText: '^^k',
                        sortText: '0^^k',
                        range: replaceRange,
                        documentation: 'Kill running script'
                    },
                    {
                        label: '^^c',
                        kind: monaco.languages.CompletionItemKind.Keyword,
                        insertText: '^^c',
                        filterText: '^^c',
                        sortText: '0^^c',
                        range: replaceRange,
                        documentation: 'Clear userscript from flash'
                    },
                    {
                        label: '^^b',
                        kind: monaco.languages.CompletionItemKind.Keyword,
                        insertText: '^^b',
                        filterText: '^^b',
                        sortText: '0^^b',
                        range: replaceRange,
                        documentation: 'Enter bootloader mode'
                    },
                    
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
                        label: 'bb.switch',
                        kind: monaco.languages.CompletionItemKind.Property,
                        insertText: 'bb.switch',
                        documentation: 'Blackbird: Read 3-position switch state (-1, 0, or 1)'
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
                        label: 'bb.pulsein[n].callback',
                        kind: monaco.languages.CompletionItemKind.Property,
                        insertText: 'bb.pulsein[${1:n}].callback = function() ${2:print("pulse")} end',
                        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                        documentation: 'Blackbird: Set pulse input callback function'
                    },
                    {
                        label: 'bb.pulseout[n]:clock',
                        kind: monaco.languages.CompletionItemKind.Method,
                        insertText: 'bb.pulseout[${1:n}]:clock(${2:1})',
                        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                        documentation: 'Blackbird: Set pulse output to clock mode with division'
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

                return { suggestions };
            },
            triggerCharacters: ['^', '.', '[', ':', 'i', 'o', 'p', 'l', 'a', 'c', 't', 'm', 'b']
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

        // Use luaparse for proper Lua syntax validation
        try {
            luaparse.parse(code, {
                locations: true,
                ranges: true,
                luaVersion: '5.3'
            });
            // If parsing succeeds, clear any previous markers
            monaco.editor.setModelMarkers(model, 'lua', []);
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
            
            // Set 50/50 split for vertical layout
            const containerHeight = container.getBoundingClientRect().height;
            const halfHeight = Math.floor(containerHeight / 2);
            replPane.style.flex = `0 0 ${halfHeight}px`;
            editorPane.style.flex = `0 0 ${halfHeight}px`;
        } else {
            container.classList.add('force-horizontal');
            container.classList.remove('force-vertical');
            this.elements.horizontalLayoutBtn.classList.add('active');
            this.elements.verticalLayoutBtn.classList.remove('active');
            
            // Show horizontal arrows for horizontal layout
            swapHorizontal.style.display = 'block';
            swapVertical.style.display = 'none';
            
            // Reset to default flex for horizontal layout
            replPane.style.flex = '1';
            editorPane.style.flex = '1';
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
        
        // Reset to 50/50 split after swapping
        const isForcedVertical = container.classList.contains('force-vertical');
        const isForcedHorizontal = container.classList.contains('force-horizontal');
        const isResponsiveVertical = !isForcedHorizontal && window.innerWidth <= 768;
        const isVertical = isForcedVertical || isResponsiveVertical;
        
        if (isVertical) {
            const containerHeight = container.getBoundingClientRect().height;
            const halfHeight = Math.floor(containerHeight / 2);
            replPane.style.flex = `0 0 ${halfHeight}px`;
            editorPane.style.flex = `0 0 ${halfHeight}px`;
        } else {
            const containerWidth = container.getBoundingClientRect().width;
            const halfWidth = Math.floor(containerWidth / 2);
            replPane.style.flex = `0 0 ${halfWidth}px`;
            editorPane.style.flex = `0 0 ${halfWidth}px`;
        }
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
        this.outputText(cleaned);
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

    toggleEditor(show) {
        this.editorVisible = show;
        
        if (show) {
            // Show editor
            this.elements.toolbar.classList.remove('hidden');
            this.elements.editorPane.classList.remove('hidden');
            this.elements.splitHandle.classList.remove('hidden');
            this.elements.replPane.classList.remove('full-width');
            
            // Reset to 50/50 split when showing the editor
            const container = this.elements.splitContainer;
            const replPane = this.elements.replPane;
            const editorPane = this.elements.editorPane;
            
            const isForcedVertical = container.classList.contains('force-vertical');
            const isForcedHorizontal = container.classList.contains('force-horizontal');
            const isResponsiveVertical = !isForcedHorizontal && window.innerWidth <= 768;
            const isVertical = isForcedVertical || isResponsiveVertical;
            
            if (isVertical) {
                const containerHeight = container.getBoundingClientRect().height;
                const halfHeight = Math.floor(containerHeight / 2);
                replPane.style.flex = `0 0 ${halfHeight}px`;
                editorPane.style.flex = `0 0 ${halfHeight}px`;
            } else {
                const containerWidth = container.getBoundingClientRect().width;
                const halfWidth = Math.floor(containerWidth / 2);
                replPane.style.flex = `0 0 ${halfWidth}px`;
                editorPane.style.flex = `0 0 ${halfWidth}px`;
            }
            
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
            const lines = code.split('\n');
            for (const line of lines) {
                await this.crow.writeLine(line);
                await this.delay(1);
            }
            this.outputLine(`>> ${code.replace(/\n/g, '\n>> ')}`);
        } catch (error) {
            this.outputLine(`Error: ${error.message}`);
        }
    }

    async openBoweryBrowser() {
        this.elements.boweryModal.style.display = 'flex';
        this.elements.boweryLoading.style.display = 'block';
        this.elements.boweryError.style.display = 'none';
        this.elements.boweryList.style.display = 'none';
        this.elements.bowerySearch.value = '';
        
        // Update action text based on editor visibility
        if (this.editorVisible) {
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
            if (this.editorVisible) {
                this.scriptName = script.name;
                this.currentFile = null;
                if (this.editor) {
                    this.editor.setValue(content);
                }
                this.setModified(false);
                this.updateScriptName();
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
        if (this.editorVisible) {
            this.elements.bbboweryAction.textContent = 'Select a script to load it into the editor';
        } else {
            this.elements.bbboweryAction.textContent = 'Select a script to upload it directly to blackbird';
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
            if (this.editorVisible) {
                this.scriptName = script.name;
                this.currentFile = null;
                if (this.editor) {
                    this.editor.setValue(content);
                }
                this.setModified(false);
                this.updateScriptName();
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
