import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import { applyPreferredTheme } from './composables/theme'
import './styles/index.css'

// 挂载前先把主题类挂上：应用内容渲染之前 html 上就已经是对的主题，
// 否则深色系统下会先闪一下浅色背景。不能用 index.html 里的内联脚本代替——
// 生产环境的 CSP 是 script-src 'self'，内联脚本会被拦掉。
applyPreferredTheme()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
