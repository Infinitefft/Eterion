# Skills

项目 Skills 将使用标准目录：

```text
skills/
└── <skill-name>/
    ├── SKILL.md
    └── references/       # 可选
```

`SKILL.md` 使用 YAML frontmatter 声明与目录一致的 `name`、简短 `description`，
并可通过 `allowed-tools` 声明推荐使用的 Tool。Skills 在真实功能开发时逐个加入，
本目录不提供只为凑数量存在的示例 Skill。
