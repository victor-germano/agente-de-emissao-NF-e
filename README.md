# Agente de IA — Emissor NF-e

> Projeto em desenvolvimento para automação de emissão de Nota Fiscal Eletrônica (NF-e), construído com apoio do Claude Code. Objetivo final: validar dados, gerar o XML no padrão SEFAZ, assinar digitalmente, transmitir e entregar o PDF ao destinatário.

---

## Sobre o Projeto

Este projeto é um agente para automatizar o processo de emissão de Nota Fiscal Eletrônica (NF-e), pensado para substituir fluxos manuais e ferramentas avulsas (N8N, scripts soltos) por um único sistema. Em desenvolvimento inicial: a etapa de validação de dados e geração do XML já está implementada e testada; assinatura digital, transmissão à SEFAZ e geração de PDF ainda não existem (ver Roadmap).

Pensado inicialmente para empresas de tecnologia e medicina, mas adaptável a qualquer segmento.

---

## Status atual

### Implementado

- Modelagem dos dados da nota (destinatário, endereço, produtos)
- Validação de CNPJ, CPF, CEP, NCM e CFOP (dígitos verificadores reais)
- Geração de um XML estruturado a partir dos dados validados
- 17 testes automatizados cobrindo validadores e geração de XML
- CI no GitHub Actions rodando a suíte a cada push/PR

### Planejado (ver Roadmap)

- Geração do XML no schema oficial NF-e 4.0 da SEFAZ
- Assinatura digital com certificado A1/A3
- Transmissão à SEFAZ (homologação/produção) e tratamento de rejeições
- Geração do DANFE em PDF e envio por e-mail
- API REST para emissão via HTTP

---

## Fluxo alvo

```
Entrada de dados (JSON/formulário/API)
        |
Validação dos dados                      [implementado]
        |
Geração do XML                           [implementado — formato interno]
        |
Geração do XML no schema oficial SEFAZ   [planejado]
        |
Assinatura digital (certificado A1/A3)   [planejado]
        |
Transmissão à SEFAZ                      [planejado]
        |
Geração do DANFE em PDF + envio          [planejado]
```

---

## Tecnologias

| Camada | Tecnologia |
|---|---|
| Linguagem | Python 3.11+ |
| Validação e modelagem | dataclasses, xml.etree.ElementTree (stdlib) |
| Testes | pytest |
| CI | GitHub Actions |

---

## Como Usar

### Pré-requisitos

- Python 3.11+

### Instalação

```bash
git clone https://github.com/victor-germano/agente-de-emissao-NF-e.git
cd agente-de-emissao-NF-e

python -m venv venv
source venv/bin/activate  # Linux/Mac
venv\Scripts\activate     # Windows

pip install -r requirements.txt
```

### Rodando os testes

```bash
python -m pytest -v
```

### Gerando o XML de uma nota

```python
from emissor import Destinatario, Endereco, NotaFiscal, Produto, construir_xml

nota = NotaFiscal(
    destinatario=Destinatario(
        cnpj="11.222.333/0001-81",
        razao_social="Empresa Exemplo LTDA",
        email="fiscal@empresa.com",
        endereco=Endereco(
            logradouro="Rua Exemplo",
            numero="100",
            municipio="São Paulo",
            uf="SP",
            cep="01001-000",
        ),
    ),
    produtos=[
        Produto(
            descricao="Serviço de Desenvolvimento de Software",
            ncm="84719000",
            cfop="5102",
            quantidade=1,
            valor_unitario=1500.00,
            aliquota_iss=2.0,
        )
    ],
    forma_pagamento="PIX",
    observacoes="Referente ao contrato nº 001/2026",
)

print(construir_xml(nota))
```

Notas inválidas levantam `NotaInvalidaError` com a lista de problemas encontrados (CNPJ inválido, NCM fora do formato, etc.).

---

## Estrutura do Projeto

```
agente-de-emissao-NF-e/
├── emissor/
│   ├── __init__.py
│   ├── modelos.py        # Destinatario, Endereco, Produto, NotaFiscal
│   ├── validadores.py    # CNPJ, CPF, CEP, NCM, CFOP + validação da nota
│   └── xml_builder.py    # Geração do XML a partir da nota validada
├── tests/
│   ├── test_validadores.py
│   └── test_xml_builder.py
├── .github/workflows/ci.yml
├── .env.example           # variáveis previstas para as próximas etapas (SEFAZ/e-mail)
├── requirements.txt
└── README.md
```

---

## Segurança

- Certificados digitais nunca versionados (`.gitignore`)
- Credenciais carregadas exclusivamente via variáveis de ambiente

---

## Roadmap

- XML no schema oficial NF-e 4.0 da SEFAZ
- Assinatura digital com certificado A1/A3
- Transmissão à SEFAZ (homologação e produção)
- Tratamento de rejeições e cancelamento/CC-e
- Geração do DANFE em PDF
- Envio automático por e-mail
- API REST para emissão via HTTP
- Interface web para emissão manual

---

## Autor

**Victor Germano** — Desenvolvedor Web Full Stack, IA & Automação

- Portfólio: [victor-germano.github.io/portfolio-germano-dev](https://victor-germano.github.io/portfolio-germano-dev)
- E-mail: dev.germanoo@gmail.com
- LinkedIn: [linkedin.com/in/victor-germano-65787b2b1](https://linkedin.com/in/victor-germano-65787b2b1)

---

## Licença

MIT License — sinta-se livre para usar, estudar e adaptar com os devidos créditos.
