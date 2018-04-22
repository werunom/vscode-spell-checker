// cSpell:ignore pycache
import { Connection, TextDocumentUri } from './vscode.workspaceFolders';
import * as vscode from './vscode.workspaceFolders';
import {
    ExcludeFilesGlobMap,
    ExclusionFunction,
    Glob
} from 'cspell';
import * as path from 'path';
import * as fs from 'fs-extra';

import * as CSpell from 'cspell';
import { CSpellUserSettings } from './cspellConfig';
import Uri from 'vscode-uri';
import { log } from './util';

// The settings interface describe the server relevant settings part
export interface SettingsCspell {
    cSpell?: CSpellUserSettings;
}

export interface SettingsVSCode {
    search?: {
        exclude?: ExcludeFilesGlobMap;
    };
}

interface VsCodeSettings {
    [key: string]: any;
}

interface ExtSettings {
    uri: string;
    vscodeSettings: SettingsCspell;
    settings: CSpellUserSettings;
    fnFileExclusionTest: ExclusionFunction;
}

const defaultExclude: Glob[] = [
    'debug:*',
    'debug:/**',        // Files that are generated while debugging (generally from a .map file)
    'vscode:/**',       // VS Code generated files (settings.json for example)
    'private:/**',
    'markdown:/**',     // The HTML generated by the markdown previewer
    'git-index:/**',    // Ignore files loaded for git indexing
    '**/*.rendered',
    '**/*.*.rendered',
    '__pycache__/**',   // ignore cache files.
];

const defaultAllowedSchemas = ['file', 'untitled'];
const schemaBlackList = ['git', 'output', 'debug', 'vscode'];

export class DocumentSettings {
    // Cache per folder settings
    private _settingsByWorkspaceFolder: Promise<Map<string, ExtSettings>> | undefined;
    private readonly settingsByDoc = new Map<string, CSpellUserSettings>();
    private _folders: Promise<vscode.WorkspaceFolder[]> | undefined;
    readonly configsToImport = new Set<string>();
    private _importSettings: CSpellUserSettings | undefined;
    private _version = 0;

    constructor(readonly connection: Connection, readonly defaultSettings: CSpellUserSettings) {}

    async getSettings(document: TextDocumentUri): Promise<CSpellUserSettings> {
        return this.getUriSettings(document.uri);
    }

    async getUriSettings(uri?: string): Promise<CSpellUserSettings> {
        const key = uri || '';
        const s = this.settingsByDoc.get(key);
        if (s) {
            return s;
        }
        log('getUriSettings:', uri);
        const r = uri
            ? await this.fetchUriSettings(uri!)
            : CSpell.mergeSettings(this.defaultSettings, this.importSettings);
        this.settingsByDoc.set(key, r);
        return r;
    }

    async isExcluded(uri: string): Promise<boolean> {
        const settingsByWorkspaceFolder = await this.findMatchingFolderSettings(uri);
        const fnExclTests = settingsByWorkspaceFolder.map(s => s.fnFileExclusionTest);
        for (const fn of fnExclTests) {
            if (fn(uri)) {
                return true;
            }
        }
        return false;
    }

    resetSettings() {
        log(`resetSettings`);
        this._settingsByWorkspaceFolder = undefined;
        this.settingsByDoc.clear();
        this._folders = undefined;
        this._importSettings = undefined;
        this._version += 1;
    }

    get folders(): Promise<vscode.WorkspaceFolder[]> {
        if (!this._folders) {
            this._folders = this.fetchFolders();
        }
        return this._folders!;
    }

    private get settingsByWorkspaceFolder() {
        if (!this._settingsByWorkspaceFolder) {
            this._settingsByWorkspaceFolder = this.fetchFolderSettings();
        }
        return this._settingsByWorkspaceFolder!;
    }

    get importSettings() {
        if (!this._importSettings) {
            log(`importSettings`);
            const importPaths = [...configsToImport.keys()].sort();
            this._importSettings = CSpell.readSettingsFiles(importPaths);
        }
        return this._importSettings!;
    }

    get version() {
        return this._version;
    }

    registerConfigurationFile(path: string) {
        log('registerConfigurationFile:', path);
        configsToImport.add(path);
        this._importSettings = undefined;
    }

    private async fetchUriSettings(uri: string): Promise<CSpellUserSettings> {
        log('Start fetchUriSettings:', uri);
        const folderSettings = (await this.findMatchingFolderSettings(uri)).map(s => s.settings);
        // Only use file Settings if we do not have any folder Settings.
        const fileSettings: CSpellUserSettings = folderSettings.length ? {} : (await this.fetchSettingsForUri(uri, {})).settings;
        const spellSettings = CSpell.mergeSettings(this.defaultSettings, this.importSettings, ...folderSettings, fileSettings);
        log('Finish fetchUriSettings:', uri);
        return spellSettings;
    }

    private async findMatchingFolderSettings(docUri: string): Promise<ExtSettings[]> {
        const settingsByFolder = await this.settingsByWorkspaceFolder;
        return [...settingsByFolder.values()]
            .filter(({uri}) => uri === docUri.slice(0, uri.length))
            .sort((a, b) => a.uri.length - b.uri.length)
            .reverse();
    }

    private async fetchFolders() {
        return await vscode.getWorkspaceFolders(this.connection) || [];
    }

    private async fetchFolderSettings() {
        log('fetchFolderSettings');
        const folders = await this.fetchFolders();
        const workplaceSettings = readAllWorkspaceFolderSettings(folders);
        const extSettings = workplaceSettings.map(async ([uri, settings]) => this.fetchSettingsForUri(uri, settings));
        return new Map<string, ExtSettings>((await Promise.all(extSettings)).map(s => [s.uri, s] as [string, ExtSettings]));
    }

    private async fetchSettingsForUri(uri: string, settings: CSpellUserSettings): Promise<ExtSettings> {
        const configs = await vscode.getConfiguration(this.connection, [
            { scopeUri: uri, section: 'cSpell' },
            { section: 'search' }
        ]) as [CSpellUserSettings, VsCodeSettings];
        const [ cSpell, search ] = configs;
        const { exclude = {} } = search;
        const cSpellConfigSettings: CSpellUserSettings = { id: 'VSCode-Config', ...cSpell };

        const mergedSettings = CSpell.mergeSettings(settings, cSpellConfigSettings);
        const { ignorePaths = []} = mergedSettings;
        const { allowedSchemas = defaultAllowedSchemas } = cSpell;
        const allowedSchemasSet = new Set(allowedSchemas);
        const globs = defaultExclude.concat(ignorePaths, CSpell.ExclusionHelper.extractGlobsFromExcludeFilesGlobMap(exclude));
        log(`fetchFolderSettings: URI ${uri}`);
        const root = uri;
        const fnFileExclusionTest = CSpell.ExclusionHelper.generateExclusionFunctionForUri(globs, root, allowedSchemasSet);

        const ext: ExtSettings = {
            uri,
            vscodeSettings: { cSpell },
            settings: mergedSettings,
            fnFileExclusionTest,
        };
        return ext;
    }
}

const configsToImport = new Set<string>();

function configPathsForRoot(workspaceRootUri?: string) {
    const workspaceRoot = workspaceRootUri ? Uri.parse(workspaceRootUri).fsPath : '';
    const paths = workspaceRoot ? [
        path.join(workspaceRoot, '.vscode', CSpell.defaultSettingsFilename.toLowerCase()),
        path.join(workspaceRoot, '.vscode', CSpell.defaultSettingsFilename),
        path.join(workspaceRoot, CSpell.defaultSettingsFilename.toLowerCase()),
        path.join(workspaceRoot, CSpell.defaultSettingsFilename),
    ] : [];
    return paths;
}

function readAllWorkspaceFolderSettings(workspaceFolders: vscode.WorkspaceFolder[]): [string, CSpellUserSettings][] {
    CSpell.clearCachedSettings();
    return workspaceFolders
        .map(folder => folder.uri)
        .filter(uri => log(`readAllWorkspaceFolderSettings URI ${uri}`) || true)
        .map(uri => [uri, configPathsForRoot(uri)] as [string, string[]])
        .map(([uri, paths]) => [uri, readSettingsFiles(paths)] as [string, CSpellUserSettings]);
}

function readSettingsFiles(paths: string[]) {
    log(`readSettingsFiles:`, paths);
    const existingPaths = paths.filter(filename => fs.existsSync(filename));
    return CSpell.readSettingsFiles(existingPaths);
}

export function isUriAllowed(uri: string, schemas?: string[]) {
    schemas = schemas || defaultAllowedSchemas;
    return doesUriMatchAnySchema(uri, schemas);
}

export function isUriBlackListed(uri: string, schemas: string[] = schemaBlackList) {
    return doesUriMatchAnySchema(uri, schemas);
}

export function doesUriMatchAnySchema(uri: string, schemas: string[]): boolean {
    const schema = uri.split(':')[0];
    return schemas.findIndex(v => v === schema) >= 0;
}