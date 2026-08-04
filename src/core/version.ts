// Factory 产物版本。写入备份 manifest 的 factory_version，供未来 restore 识别生产者版本。
// 随发布 bump；OP3-B 前向兼容基础（v1=identity，零行为变更）。
export const FACTORY_VERSION = '0.1.0';
