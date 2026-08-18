/**
 * DOM 操作工具模块
 * DOM manipulation utilities
 */

class DOMUtils {
  /**
   * 安全查询元素
   */
  static $(selector, parent = document) {
    return parent.querySelector(selector);
  }

  /**
   * 查询所有元素
   */
  static $$(selector, parent = document) {
    return Array.from(parent.querySelectorAll(selector));
  }

  /**
   * 获取元素文本（去除空白）
   */
  static getText(element) {
    if (!element) return '';
    return element.textContent?.trim() || '';
  }

  /**
   * 获取元素属性
   */
  static getAttr(element, name) {
    if (!element) return '';
    return element.getAttribute(name) || '';
  }

  /**
   * 解析薪资字符串
   */
  static parseSalary(salaryText) {
    if (!salaryText) return { min: 0, max: 0, unit: 'K' };
    
    // 匹配 "10-20K" 或 "10K-20K" 或 "10-20千"
    const match = salaryText.match(/(\d+\.?\d*)\s*[-~至]\s*(\d+\.?\d*)\s*([K万千])/);
    if (match) {
      const min = parseFloat(match[1]);
      const max = parseFloat(match[2]);
      const unit = match[3];
      return { min, max, unit, original: salaryText };
    }

    // 匹配 "面议"
    if (salaryText.includes('面议')) {
      return { min: 0, max: 0, unit: '面议', original: salaryText };
    }

    return { min: 0, max: 0, unit: '未知', original: salaryText };
  }

  /**
   * 从 URL 解析岗位 ID
   */
  static extractJobId(url) {
    if (!url) return '';
    
    // BOSS直聘: /job_detail/abc123.html
    const bossMatch = url.match(/job_detail\/([a-zA-Z0-9]+)/);
    if (bossMatch) return bossMatch[1];

    // 猎聘: /job/123456.html
    const liepinMatch = url.match(/job\/(\d+)/);
    if (liepinMatch) return liepinMatch[1];

    // 智联: /jobs/123456.html
    const zhilianMatch = url.match(/jobs\/(\d+)/);
    if (zhilianMatch) return zhilianMatch[1];

    // 前程: /job/123456.html
    const qianchengMatch = url.match(/job\/(\d+)/);
    if (qianchengMatch) return qianchengMatch[1];

    return '';
  }

  /**
   * 检测页面类型
   */
  static detectPageType() {
    const url = window.location.href;
    const hostname = window.location.hostname;

    if (hostname.includes('zhipin.com')) {
      if (url.includes('/job_detail/')) return 'boss-detail';
      if (url.includes('/web/geek/job')) return 'boss-list';
      if (url.includes('/web/user/?')) return 'boss-profile';
      return 'boss-other';
    }

    if (hostname.includes('liepin.com')) {
      if (url.includes('/job/')) return 'liepin-detail';
      if (url.includes('/zhaopin/')) return 'liepin-list';
      return 'liepin-other';
    }

    if (hostname.includes('zhaopin.com')) {
      if (url.includes('/jobs/')) return 'zhilian-detail';
      if (url.includes('/sou/')) return 'zhilian-list';
      return 'zhilian-other';
    }

    if (hostname.includes('51job.com')) {
      if (url.includes('/job/')) return 'qiancheng-detail';
      return 'qiancheng-other';
    }

    return 'unknown';
  }

  /**
   * 创建隐藏的 textarea（用于复制）
   */
  static createHiddenTextarea(text) {
    const textarea = document.createElement('textarea');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '-9999px';
    textarea.value = text;
    document.body.appendChild(textarea);
    return textarea;
  }

  /**
   * 复制文本到剪贴板
   */
  static async copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      // 降级方案
      const textarea = this.createHiddenTextarea(text);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      return true;
    }
  }

  /**
   * 等待元素可见
   */
  static async waitForVisible(selector, timeout = 5000) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const el = document.querySelector(selector);
      if (el) {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        
        if (rect.width > 0 && 
            rect.height > 0 && 
            style.visibility !== 'hidden' && 
            style.display !== 'none') {
          return el;
        }
      }
      await new Promise(r => setTimeout(r, 100));
    }

    return null;
  }

  /**
   * 检测是否登录
   */
  static checkLogin(hostname) {
    switch (hostname) {
      case 'www.zhipin.com':
        // BOSS直聘：检测用户头像
        return !!document.querySelector('.user-nav, .nav-figure, [class*="avatar"]');
      
      case 'www.liepin.com':
        // 猎聘：检测用户信息
        return !!document.querySelector('.user-info, .username');
      
      case 'www.zhaopin.com':
        // 智联：检测登录状态
        return !!document.querySelector('.user-login, .username');
      
      case 'www.51job.com':
        // 前程：检测登录状态
        return !!document.querySelector('.login-name, .user-name');
      
      default:
        return false;
    }
  }
}

// 导出
if (typeof window !== 'undefined') {
  window.DOMUtils = DOMUtils;
}