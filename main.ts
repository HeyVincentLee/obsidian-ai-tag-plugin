import {
	App,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	Notice,
	requestUrl,
	RequestUrlResponse,
	MarkdownView,
} from "obsidian"

interface AIAssistantSettings {
	apiKey: string
	modelName: string
	baseURL: string
	customPrompt: string
	maxResults: number
}

const DEFAULT_SETTINGS: AIAssistantSettings = {
	apiKey: "",
	modelName: "openai/gpt-4o-mini-2024-07-18",
	baseURL: "https://openrouter.ai/api/v1",
	customPrompt: `
	请根据以下笔记的标题和内容，生成最多4个最贴合、最精准的标签。重要提示：
	1. 只生成真正相关和必要的标签，不要强行填满4个。
	2. 如果内容只能概括出较少的标签，请只返回这些精确的标签。
	3. 每个标签不超过3个词，不包含#符号。
	4. 直接列出标签，用逗号分隔，不要有其他解释。
	`,
	maxResults: 4,
}

export default class AIAssistant extends Plugin {
	settings: AIAssistantSettings

	async onload() {
		await this.loadSettings()

		this.addCommand({
			id: "generate-ai-tags",
			name: "生成AI标签",
			callback: () => this.generateTags(),
		})

		this.addRibbonIcon("tag", "生成AI标签", () => {
			this.generateTags()
		})

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				menu.addItem((item) => {
					item
						.setTitle("生成AI标签")
						.setIcon("tag")
						.onClick(() => this.generateTags())
				})
			}),
		)

		this.addSettingTab(new AIAssistantSettingTab(this.app, this))
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
	}

	async saveSettings() {
		await this.saveData(this.settings)
	}

	async generateTags() {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView)
		if (!activeView) {
			new Notice("没有活动的Markdown视图")
			return
		}

		const editor = activeView.editor
		const selectedText = editor.getSelection()
		const file = activeView.file

		if (!file) {
			new Notice("没有活动的文件")
			return
		}

		try {
			let tags
			if (selectedText) {
				// 如果有选中文本，只根据选中的文本生成标签
				tags = await this.getTagsFromAI("", selectedText)
			} else {
				// 如果没有选中文本，使用标题和整个笔记内容生成标签
				const fullContent = editor.getValue()
				tags = await this.getTagsFromAI(file.basename, fullContent)
			}

			if (tags && tags.length > 0) {
				await this.updateFileTags(file, tags)
			} else {
				new Notice("未能生成标签")
			}
		} catch (error) {
			console.error("生成标签时发生错误:", error)
			new Notice("生成标签时发生错误")
		}
	}

	async getTagsFromAI(title: string, content: string): Promise<string[]> {
		const apiUrl = `${this.settings.baseURL}/chat/completions`
		const prompt = `${this.settings.customPrompt}

${title ? `标题: "${title}"` : ""}

内容:
${content.substring(0, 1000)}

请生成标签:`

		try {
			const response: RequestUrlResponse = await requestUrl({
				url: apiUrl,
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.settings.apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model: this.settings.modelName,
					messages: [
						{
							role: "system",
							content:
								"你是一个专业的笔记标签生成助手，善于提炼核心概念，只生成真正相关和必要的标签。请用中文回答。",
						},
						{ role: "user", content: prompt },
					],
				}),
			})

			if (response.status === 200) {
				const result = JSON.parse(response.text)
				const content = result.choices[0].message.content.trim()
				const tags = content
					.split(/[,，]/) // 同时处理英文逗号和中文逗号
					.map((tag: string) => tag.trim())
					.filter((tag: string) => tag !== "")

				return tags.slice(0, this.settings.maxResults)
			} else {
				console.error("AI API 请求失败:", response.status, response.text)
				throw new Error("AI API 请求失败")
			}
		} catch (error) {
			console.error("调用 AI API 时发生错误:", error)
			throw error
		}
	}

	async updateFileTags(file: TFile, newTags: string[]) {
		const content = await this.app.vault.read(file)
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter

		let newContent: string

		if (frontmatter) {
			// 创建一个新的 frontmatter 对象，但不包含原有的 tags
			const updatedFrontmatter = { ...frontmatter }
			delete updatedFrontmatter.tags

			// 只有在有新标签时才添加 tags 字段
			if (newTags.length > 0) {
				updatedFrontmatter.tags = newTags
			}

			const frontmatterStr = JSON.stringify(updatedFrontmatter, null, 2)
			newContent = content.replace(/^---\n([\s\S]*?)\n---/, `---\n${frontmatterStr}\n---`)
		} else {
			// 如果之前没有 frontmatter，只在有新标签时才创建
			if (newTags.length > 0) {
				const frontmatterStr = JSON.stringify({ tags: newTags }, null, 2)
				newContent = `---\n${frontmatterStr}\n---\n\n${content}`
			} else {
				newContent = content // 如果没有新标签，保持原内容不变
			}
		}

		await this.app.vault.modify(file, newContent)

		if (newTags.length > 0) {
			new Notice(`标签已更新: ${newTags.join(", ")}`)
		} else {
			new Notice("所有标签已清除")
		}
	}
}

class AIAssistantSettingTab extends PluginSettingTab {
	plugin: AIAssistant

	constructor(app: App, plugin: AIAssistant) {
		super(app, plugin)
		this.plugin = plugin
	}

	display(): void {
		const { containerEl } = this
		containerEl.empty()
		containerEl.createEl("h2", { text: "AI 标签助手设置" })

		new Setting(containerEl)
			.setName("API 密钥")
			.setDesc("输入你的 AI 服务 API 密钥")
			.addText((text) =>
				text
					.setPlaceholder("输入 API 密钥")
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value
						await this.plugin.saveSettings()
					}),
			)

		new Setting(containerEl)
			.setName("模型名称")
			.setDesc("输入 AI 模型名称")
			.addText((text) =>
				text
					.setPlaceholder("输入模型名称")
					.setValue(this.plugin.settings.modelName)
					.onChange(async (value) => {
						this.plugin.settings.modelName = value
						await this.plugin.saveSettings()
					}),
			)

		new Setting(containerEl)
			.setName("AI 服务基础 URL")
			.setDesc("输入 AI 服务的基础 URL（例如：https://api.openai.com/v1）")
			.addText((text) =>
				text
					.setPlaceholder("输入基础 URL")
					.setValue(this.plugin.settings.baseURL)
					.onChange(async (value) => {
						this.plugin.settings.baseURL = value
						await this.plugin.saveSettings()
					}),
			)

		new Setting(containerEl)
			.setName("自定义提示")
			.setDesc("输入你的自定义提示")
			.addTextArea((text) =>
				text
					.setPlaceholder("输入自定义提示")
					.setValue(this.plugin.settings.customPrompt)
					.onChange(async (value) => {
						this.plugin.settings.customPrompt = value
						await this.plugin.saveSettings()
					}),
			)

		new Setting(containerEl)
			.setName("最大标签数量")
			.setDesc("设置生成标签的最大数量")
			.addSlider((slider) =>
				slider
					.setLimits(1, 10, 1)
					.setValue(this.plugin.settings.maxResults)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.maxResults = value
						await this.plugin.saveSettings()
					}),
			)
	}
}
