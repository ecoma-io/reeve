<p align="center">
</p>

<p align="center">
  <a href="https://github.com/ecoma-io/reeve/actions/workflows/ci.yml"><img src="https://github.com/ecoma-io/reeve/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/ecoma-io/reeve/actions/workflows/analysis.yml"><img src="https://github.com/ecoma-io/reeve/actions/workflows/analysis.yml/badge.svg" alt="Analysis" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache 2.0" /></a>
  <a href="https://github.com/ecoma-io/reeve/releases/latest"><img src="https://img.shields.io/github/v/release/ecoma-io/reeve?sort=semver&color=brightgreen" alt="Latest release" /></a>
  <a href="CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-7C3AED.svg" alt="Pull requests welcome" /></a>
</p>

<!-- reeve:ignore-start -->
<p align="center">
  <sub><a href="README.md">English</a> · <strong>Tiếng Việt</strong> · <a href="README.zh.md">中文</a></sub>
</p>
<!-- reeve:ignore-end -->

<p align="center">
  <img src=".github/assets/banner.png" alt="Reeve — bảo trì repository, bằng ngôn ngữ của mọi contributor" width="100%" />
</p>

<h1 align="center">Reeve</h1>

<p align="center">
  <strong>Báo cáo lỗi hữu ích nhất bạn từng nhận được lại được viết bằng một ngôn ngữ bạn không đọc được.</strong><br />
  Reeve giữ cho công việc lặp lại của một repository luôn được vận hành — phân loại, đối chiếu, trả lời, rà soát, duy trì dependency —<br />
  <em>bằng bất kỳ ngôn ngữ nào nó xuất hiện, trong phạm vi thẩm quyền bạn đã viết ra và nó không thể vượt qua.</em>
</p>

## Vì sao có Reeve

Các contributor của bạn không phải ai cũng dùng chung một ngôn ngữ, nhưng mọi
công cụ nghiêm túc trong lĩnh vực này lại hành xử như thể họ có. Điều đó bộc
lộ ở nơi ít được nhìn thấy nhất: không phải ở việc dịch thuật, mà ở các
**quyết định**. Việc phân loại còn tệ hơn. Phát hiện trùng lặp đơn giản là
thất bại — hai báo cáo về cùng một lỗi crash, một viết bằng tiếng Việt và một
bằng tiếng Anh, không bao giờ gặp nhau. Người viết báo cáo hữu ích nhất bạn
nhận được trong tháng này lại nhận được câu trả lời chậm hơn, tệ hơn so với
người viết một báo cáo mơ hồ hơn bằng tiếng Anh.

Reeve coi ngôn ngữ là thứ mà lõi hệ thống nắm rõ và mọi duty đều sử dụng.
Và nó vận hành đúng như tên gọi của nó: một "reeve" là viên quan điều hành
một điền trang thay mặt cho chủ sở hữu — công việc hằng ngày, được thực hiện
mà không cần yêu cầu mỗi lần, trong phạm vi thẩm quyền mà chủ sở hữu đã cấp
và có thể thu hồi bất cứ lúc nào. Chủ sở hữu vẫn luôn là chủ sở hữu. Không
phải một chatbot, không phải một dịch vụ hosted, không phải một workflow
engine — chín duty, một file warrant, repository của chính bạn.
[Ngôi sao dẫn đường](docs/doctrine/north-star.md) chính là toàn bộ luận điểm.

## Các duty

Mỗi duty là một action riêng biệt. Những gì chạy đúng bằng những gì bạn đã
viết ra, từng nấc một trên [chiếc thang](docs/concepts/authority-model.md).

| Duty          | Chức năng                                                                                                                                                                               | Tài liệu                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `triage`      | Phân loại backlog theo taxonomy bạn đã viết — hoặc, ở nấc thấp nhất, theo các label mà repository của bạn đã có sẵn.                                                                    | [Tài liệu](docs/reference/duties/triage.md)      |
| `translate`   | Đưa mọi issue và pull request vào mọi ngôn ngữ dự án của bạn đọc được — ngay trong nội dung (body) của chính thread, được đánh dấu là bản tính.                                         | [Tài liệu](docs/reference/duties/translate.md)   |
| `duplicate`   | Tìm ra thread đã báo cáo vấn đề này rồi — xuyên suốt ngôn ngữ mà nó được báo cáo. Opt-in, không bao giờ bật một cách vô tình.                                                           | [Tài liệu](docs/reference/duties/duplicate.md)   |
| `respond`     | Đưa cho người lạ câu trả lời đầu tiên, hữu ích, bằng chính ngôn ngữ họ đã viết cho bạn, dựa trên những gì dự án đã biết. Không được cấp gì cho tới khi warrant nêu tên nó.              | [Tài liệu](docs/reference/duties/respond.md)     |
| `review`      | Rà soát một pull request — kiểm tra tất định trước, sau đó các lượt chạy model theo cấp rủi ro được tổng hợp thành một comment do chính nó sở hữu, theo dõi phát hiện thay vì đăng lại. | [Tài liệu](docs/reference/duties/review.md)      |
| `remediation` | Chuyển các phát hiện còn hiệu lực của một review thành đề xuất khắc phục tất định — ghi lại trên job summary, không bao giờ ghi vào repository.                                         | [Tài liệu](docs/reference/duties/remediation.md) |
| `lifecycle`   | Chạy chính sách staleness của riêng bạn — nhắc nhở, gỡ trạng thái stale, đóng cuối cùng dưới dạng not planned — chỉ dựa trên timestamp và label. Không bao giờ gọi model.               | [Tài liệu](docs/reference/duties/lifecycle.md)   |
| `harmonise`   | Giữ tài liệu của bạn đồng bộ xuyên suốt các ngôn ngữ khi bản gốc thay đổi. Chỉ báo cáo cho tới khi warrant cấp thêm quyền.                                                              | [Tài liệu](docs/reference/duties/harmonise.md)   |
| `dependa`     | Duy trì dependency của bạn — phát hiện bản cập nhật, đánh giá rủi ro, mở PR có thể review. Chỉ báo cáo cho tới khi warrant cấp thêm quyền.                                              | [Tài liệu](docs/reference/duties/dependa.md)     |

Những gì đến sau chín duty này được quyết định bởi một bài kiểm tra nghiêm
ngặt duy nhất — lặp lại, tốn kém một cách đồng đều, đã từng bị maintainer bỏ
cuộc, và khó khăn hơn trên một dự án đa ngôn ngữ.
[Doctrine D10](docs/doctrine/north-star.md#d10--a-duty-must-earn-its-place)
từ chối phần lớn các yêu cầu tính năng, một cách có chủ đích.

## Bắt đầu nhanh

Năm phút, hai duty, không có gì được ghi cho tới khi bạn đồng ý:

> [!IMPORTANT]
> Chạy workflow này sẽ phát sinh chi phí trên tài khoản model provider của bạn.
> `dry-run: true` chạy toàn bộ pipeline mà không ghi bất cứ điều gì — hãy dùng nó trước tiên.

1. **Lưu một model key** dưới dạng repository secret có tên `OPENAI_API_KEY`
   — hoặc trỏ `base-url` tới bất kỳ endpoint tương thích OpenAI nào, kể cả
   một endpoint miễn phí không cần key: [Providers and the runtime](docs/guides/providers.md).
2. **Thêm một workflow:**

```yaml
name: Reeve

on:
  issues:
    types: [opened, reopened, edited]

permissions:
  contents: read
  issues: write

jobs:
  triage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ecoma-io/reeve/triage@v0.6
        with:
          api-key: ${{ secrets.OPENAI_API_KEY }}
          models: gpt-5-mini
          dry-run: true # safe first run — remove when you trust it

  translate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ecoma-io/reeve/translate@v0.6
        with:
          api-key: ${{ secrets.OPENAI_API_KEY }}
          models: gpt-5-mini
          dry-run: true # safe first run — remove when you trust it
```

> [!NOTE]
> `actions/checkout` là bắt buộc: Reeve đọc file warrant của bạn
> (`.github/reeve.yml`) từ bản checkout cục bộ, không phải từ GitHub API.

Hướng dẫn đầy đủ — trigger, permission, pinning:
[Installation](docs/getting-started/installation.md) và
[workflow đầu tiên của bạn](docs/getting-started/first-workflow.md). Trước
khi tin tưởng một warrant, hãy hỏi Reeve xem nó sẽ làm gì:
[the doctor](docs/guides/doctor.md) đọc cấu hình của bạn và báo cáo những gì
mỗi duty sẽ được cấp, không ghi bất cứ điều gì.

## Một thẩm quyền bạn tự viết ra

Một file duy nhất — `.github/reeve.yml` — là toàn bộ thẩm quyền. Không viết
gì cả thì mọi duty chạy ở mức built-in default hẹp nhất. Viết một block
`duties:` thì việc liệt kê trở thành toàn diện: một duty không được block
này nêu tên sẽ không được cấp bất cứ quyền gì. File workflow quyết định
_khi nào_ một lượt chạy diễn ra; nó không thể cấp một capability, và cũng
không có gì mà model nói có thể làm được điều đó.
Mọi sự mở rộng quyền đều là một diff trên chính file đó, được review như bất
kỳ thay đổi nào khác.

[The authority model](docs/concepts/authority-model.md) ·
[The warrant guide](docs/guides/warrant.md) ·
[Every grant, enumerated](docs/reference/warrant-format.md#the-capabilities-table)

## Những gì nó từ chối làm

Bảng quan trọng nhất trên trang này, và mọi dòng đều được enforce trong code:

|                                         |                                                                                                                                                                                                                                                       |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hành động ngoài phạm vi warrant**     | Một label mà taxonomy của bạn không nêu tên sẽ không bao giờ được áp dụng; một capability bạn không cấp sẽ không bao giờ được dùng. Được kiểm tra dựa trên file đã parse — không bao giờ dựa trên lời tự nhận của model về những gì nó được phép làm. |
| **Viết lại những gì một người đã viết** | Tiêu đề và nội dung thuộc về người đã viết ra chúng. Output của máy đứng bên cạnh văn bản của con người, được đánh dấu rõ, không bao giờ thay thế nó.                                                                                                 |
| **Lấn quyền maintainer**                | Nó không bao giờ gỡ một label do người khác gán, không bao giờ reassign, không bao giờ reopen. Nó đề xuất; bạn quyết định.                                                                                                                            |
| **Close, lock, hoặc delete**            | Mặc định tắt và luôn giữ như vậy. Mọi hành động vượt quá hành động rẻ nhất có thể hoàn tác đều là opt-in, từng cái một.                                                                                                                               |
| **Đoán mò khi không đọc được**          | Output của model không parse được sẽ cho ra **không** kết quả nào và một failure đỏ rõ ràng — không phải một nỗ lực đọc các phần trông có vẻ ổn.                                                                                                      |
| **Giả vờ như đã thành công**            | Một lượt chạy không thể hoàn thành công việc sẽ fail đỏ. Nó không bao giờ báo cáo một kết quả rỗng dưới màu xanh.                                                                                                                                     |
| **Giữ dữ liệu của bạn**                 | Không tài khoản, không dashboard, không trạng thái hosted. Mọi thứ Reeve biết đều là các file thuần trong repository của bạn — được review trong một pull request, xoá bằng `rm`.                                                                     |

Lý do đằng sau mỗi ranh giới nằm trong
[the threat model](docs/security/threat-model.md).

## Chi phí

Bước tốn kém nhất chạy sau cùng và ít nhất:

| Bậc                | Quyết định                                                                  | Chi phí      |
| ------------------ | --------------------------------------------------------------------------- | ------------ |
| **Code**           | Body rỗng, template chưa điền, lặp lại y hệt, các thread Reeve đã xử lý rồi | Miễn phí     |
| **Một model rẻ**   | Điều này có đáng để đọc kỹ không — spam, lạc chủ đề, ngoài phạm vi          | Rất ít       |
| **Model bạn chọn** | Kết luận thực sự, trên những gì còn sót lại                                 | Chi phí thực |

Bất kỳ endpoint tương thích OpenAI nào cũng hoạt động — OpenAI, một gateway,
một model tự host, một gói miễn phí không cần key — và không cái nào trong
số đó là một cuộc migration.
[Cost](docs/guides/cost.md), kèm một ước tính cụ thể ·
[Providers](docs/guides/providers.md).

## Bảo mật

Reeve nắm giữ một write token, đọc input được viết bởi người lạ, và suy luận
bằng một model mà chính input đó có thể cố gắng ra lệnh. Thiết kế này không
yêu cầu một prompt phải sống sót qua sự tiếp xúc với kẻ tấn công — nó biến
warrant thành thuộc tính bảo mật, được enforce như mười bất biến (invariant)
đã được kiểm chứng: văn bản không tin cậy được rào lại và đóng khung như dữ
liệu, output của máy được sanitise trước khi publish, và không có gì model
tự nhận về quyền hạn của chính nó từng được tin.
[Security, stage by stage](docs/security/security.md) ·
[Threat model](docs/security/threat-model.md) ·
[Reporting a vulnerability](SECURITY.md)

## Tài liệu

[`docs/`](docs/) là mục lục đầy đủ, được tổ chức theo đối tượng đọc:

| Nếu bạn là…                        | Bắt đầu tại                                             |
| ---------------------------------- | ------------------------------------------------------- |
| Mới làm quen với Reeve             | [Getting started](docs/getting-started/installation.md) |
| Đang cân nhắc có nên dùng nó không | [The authority model](docs/concepts/authority-model.md) |
| Vận hành nó hằng ngày              | [Guides](docs/guides/warrant.md)                        |
| Có gì đó có vẻ sai                 | [Troubleshooting](docs/guides/troubleshooting.md)       |
| Đang dùng bản `0.x` sớm            | [Migration](docs/guides/migration.md)                   |
| Đang review nó về mặt bảo mật      | [Threat model](docs/security/threat-model.md)           |
| Đang thay đổi code                 | [Development](docs/development/README.md)               |

Reeve đang ở nhánh `0.x` theo đúng cam kết thông thường của semver: một input
vẫn có thể thay đổi ở một bản minor, release notes sẽ nêu rõ khi điều đó xảy
ra, và mỗi release đều pin `v0.$MINOR` —
[ý nghĩa của `0.x` và `1.0` ở đây](docs/development/releasing.md#what-0x-and-10-mean-here).

## Giấy phép

[Apache-2.0](LICENSE).

---

<p align="center">
  <sub>
    Maintained by <a href="https://ecoma.io">Ecoma</a> ·
    <a href="https://ecoma.io">Website</a> ·
    <a href="https://github.com/ecoma-io">Github</a>
  </sub>
</p>
