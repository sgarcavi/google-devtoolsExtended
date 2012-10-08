/*
 * Copyright (C) 2012 Google Inc. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are
 * met:
 *
 *     * Redistributions of source code must retain the above copyright
 * notice, this list of conditions and the following disclaimer.
 *     * Redistributions in binary form must reproduce the above
 * copyright notice, this list of conditions and the following disclaimer
 * in the documentation and/or other materials provided with the
 * distribution.
 *     * Neither the name of Google Inc. nor the names of its
 * contributors may be used to endorse or promote products derived from
 * this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

/**
 * @constructor
 * @implements {WebInspector.SourceMapping}
 * @param {WebInspector.Workspace} workspace
 */
WebInspector.ResourceScriptMapping = function(workspace)
{
    this._workspace = workspace;
    this._workspace.addEventListener(WebInspector.Workspace.Events.ProjectWillReset, this._reset, this);
    this._workspace.addEventListener(WebInspector.UISourceCodeProvider.Events.UISourceCodeAdded, this._uiSourceCodeAddedToWorkspace, this);

    /** @type {Object.<string, WebInspector.UISourceCode>} */
    this._temporaryUISourceCodeForScriptId = {};
    this._scripts = [];
}

WebInspector.ResourceScriptMapping.prototype = {
    /**
     * @param {WebInspector.RawLocation} rawLocation
     * @return {WebInspector.UILocation}
     */
    rawLocationToUILocation: function(rawLocation)
    {
        var debuggerModelLocation = /** @type {WebInspector.DebuggerModel.Location} */ rawLocation;
        var script = WebInspector.debuggerModel.scriptForId(debuggerModelLocation.scriptId);
        var uiSourceCode = this._workspaceUISourceCodeForScript(script);
        if (!uiSourceCode)
            uiSourceCode = this._getOrCreateTemporaryUISourceCode(script);
        else if (uiSourceCode.isDirty() || uiSourceCode.hasDivergedFromVM) {
            var temporaryUISourceCode = this._getOrCreateTemporaryUISourceCode(script);
            temporaryUISourceCode.divergedVersion = uiSourceCode;
            uiSourceCode = temporaryUISourceCode;
        }
        console.assert(!!uiSourceCode);
        return new WebInspector.UILocation(uiSourceCode, debuggerModelLocation.lineNumber, debuggerModelLocation.columnNumber || 0);
    },

    _hasDivergedFromVMChanged: function(event)
    {
        var uiSourceCode = /** @type {WebInspector.UISourceCode} */ event.data;
        var scripts = this._scriptsForUISourceCode(uiSourceCode);
        if (!scripts.length)
            return;
        for (var i = 0; i < scripts.length; ++i)
            scripts[i].setSourceMapping(this);
        if (!uiSourceCode.isDirty() && !uiSourceCode.hasDivergedFromVM)
            this._deleteTemporaryUISourceCodeForScripts(scripts);
    },

    /**
     * @param {WebInspector.Script} script
     * @return {WebInspector.UISourceCode}
     */
    _workspaceUISourceCodeForScript: function(script)
    {
        if (script.isAnonymousScript() || this._isDynamicScript(script))
            return null;
        return this._workspace.uiSourceCodeForURL(script.sourceURL);
    },

    /**
     * @param {WebInspector.UISourceCode} uiSourceCode
     * @param {number} lineNumber
     * @param {number} columnNumber
     * @return {WebInspector.DebuggerModel.Location}
     */
    uiLocationToRawLocation: function(uiSourceCode, lineNumber, columnNumber)
    {
        var scripts = this._scriptsForUISourceCode(uiSourceCode);
        console.assert(scripts.length);
        return WebInspector.debuggerModel.createRawLocation(scripts[0], lineNumber, columnNumber);
    },

    /**
     * @param {WebInspector.Script} script
     */
    addScript: function(script)
    {
        if (!script.isAnonymousScript())
            this._scripts.push(script);
        script.setSourceMapping(this);
        var uiSourceCode = this._workspaceUISourceCodeForScript(script);
        if (uiSourceCode) {
            this._bindUISourceCodeToScripts(uiSourceCode, [script]);
            return;
        }

        var scripts = script.isInlineScript() ? this._scriptsForSourceURL(script.sourceURL, true) : [script];
        if (this._deleteTemporaryUISourceCodeForScripts(scripts))
            uiSourceCode = this._getOrCreateTemporaryUISourceCode(script);
    },

    /**
     * @param {Array.<WebInspector.Script>} scripts
     * @return {boolean}
     */
    _deleteTemporaryUISourceCodeForScripts: function(scripts)
    {
        var temporaryUISourceCode;
        for (var i = 0; i < scripts.length; ++i) {
            var script = scripts[i];
            temporaryUISourceCode = temporaryUISourceCode || this._temporaryUISourceCodeForScriptId[script.scriptId];
            delete this._temporaryUISourceCodeForScriptId[script.scriptId];
        }
        if (temporaryUISourceCode)
            this._workspace.project().removeTemporaryUISourceCode(temporaryUISourceCode);
        return !!temporaryUISourceCode;
    },

    /**
     * @param {WebInspector.UISourceCode} uiSourceCode
     * @param {Array.<WebInspector.Script>} scripts
     */
    _bindUISourceCodeToScripts: function(uiSourceCode, scripts)
    {
        console.assert(scripts.length);
        for (var i = 0; i < scripts.length; ++i)
            scripts[i].setSourceMapping(this);
        uiSourceCode.isContentScript = scripts[0].isContentScript;
        uiSourceCode.setSourceMapping(this);
        if (!uiSourceCode.isTemporary)
            uiSourceCode.addEventListener(WebInspector.JavaScriptSource.Events.HasDivergedFromVMChanged, this._hasDivergedFromVMChanged, this);

    },

    /**
     * @param {WebInspector.Script} script
     * @return {boolean}
     */
    _isDynamicScript: function(script)
    {
        if (script.isAnonymousScript() || script.isInlineScript())
            return false;
        var inlineScriptsWithTheSameURL = this._scriptsForSourceURL(script.sourceURL, true);
        return !!inlineScriptsWithTheSameURL.length;
    },

    /**
     * @param {string} sourceURL
     * @param {boolean} isInlineScript
     * @return {Array.<WebInspector.Script>}
     */
    _scriptsForSourceURL: function(sourceURL, isInlineScript)
    {
        function filter(script)
        {
            return script.sourceURL === sourceURL && script.isInlineScript() === isInlineScript;
        }

        return this._scripts.filter(filter.bind(this));
    },

    /**
     * @param {WebInspector.Script} script
     * @return {WebInspector.UISourceCode}
     */
    _getOrCreateTemporaryUISourceCode: function(script)
    {
        var temporaryUISourceCode = this._temporaryUISourceCodeForScriptId[script.scriptId];
        if (temporaryUISourceCode)
            return temporaryUISourceCode;

        var scripts = script.isInlineScript() ? this._scriptsForSourceURL(script.sourceURL, true) : [script];
        var contentProvider = script.isInlineScript() ? new WebInspector.ConcatenatedScriptsContentProvider(scripts) : script;
        var isDynamicScript = this._isDynamicScript(script);
        var url = isDynamicScript ? "" : script.sourceURL;
        temporaryUISourceCode = new WebInspector.JavaScriptSource(url, contentProvider, false);
        temporaryUISourceCode.isTemporary = true;
        for (var i = 0; i < scripts.length; ++i)
            this._temporaryUISourceCodeForScriptId[scripts[i].scriptId] = temporaryUISourceCode;
        this._bindUISourceCodeToScripts(temporaryUISourceCode, scripts);
        this._workspace.project().addTemporaryUISourceCode(temporaryUISourceCode);
        return temporaryUISourceCode;
    },

    _uiSourceCodeAddedToWorkspace: function(event)
    {
        var uiSourceCode = /** @type {WebInspector.UISourceCode} */ event.data;
        console.assert(!!uiSourceCode.url);

        var scripts = this._scriptsForUISourceCode(uiSourceCode);
        if (!scripts.length)
            return;

        this._deleteTemporaryUISourceCodeForScripts(scripts);
        this._bindUISourceCodeToScripts(uiSourceCode, scripts);
    },

    /**
     * @param {WebInspector.UISourceCode} uiSourceCode
     * @return {Array.<WebInspector.Script>}
     */
    _scriptsForUISourceCode: function(uiSourceCode)
    {
        var isInlineScript;
        switch (uiSourceCode.contentType()) {
        case WebInspector.resourceTypes.Document:
            isInlineScript = true;
            break;
        case WebInspector.resourceTypes.Script:
            isInlineScript = false;
            break;
        default:
            return [];
        }

        return this._scriptsForSourceURL(uiSourceCode.url, isInlineScript);
    },

    _reset: function()
    {
        this._temporaryUISourceCodeForScriptId = {};
        this._scripts = [];
    },
}
